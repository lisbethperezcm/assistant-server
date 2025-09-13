import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';
import { z } from 'zod';

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== Catalog schemas =====
const CatalogSchema = z.object({
  services: z.array(z.object({
    id: z.number(),
    name: z.string(),
    synonyms: z.array(z.string()).optional()
  })).default([]),
  barbers: z.array(z.object({
    id: z.number(),
    name: z.string()
  })).default([])
});

const IntentSchema = z.object({
  intent: z.enum(['create_appointment', 'get_next_appointment', 'search_services', 'small_talk']),
  args: z.object({
    barber: z.union([z.number(), z.null()]).optional(),
    appointment_date: z.union([z.string(), z.null()]).optional(),
    start_time: z.union([z.string(), z.null()]).optional(),
    end_time: z.union([z.string(), z.null()]).optional(),
    services: z.array(z.union([z.number(), z.string()])).default([]) // puede venir por nombre o id
  }).partial()
});

// util: normalizar texto
const norm = (s='') => s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();

// mapear nombres/sinónimos -> ID determinísticamente
function mapServicesToIds(requested, catalogServices) {
  if (!Array.isArray(requested)) return [];
  const byName = new Map();
  for (const s of catalogServices) {
    const keys = [s.name, ...(s.synonyms ?? [])].map(norm);
    keys.forEach(k => byName.set(k, s.id));
  }
  const out = [];
  for (const item of requested) {
    if (typeof item === 'number') { out.push(item); continue; }
    const id = byName.get(norm(String(item)));
    if (id) out.push(id);
  }
  // desduplicar
  return [...new Set(out)];
}

function mapBarberToId(requested, catalogBarbers) {
  if (requested == null) return null;
  if (typeof requested === 'number') return requested;
  const needle = norm(String(requested));
  const found = catalogBarbers.find(b => norm(b.name) === needle);
  return found ? found.id : null;
}

app.get('/', (_req, res) => res.send('Assistant IA lista ✅. Usa POST /chat'));

// ===== main endpoint =====
app.post('/chat', async (req, res) => {
  try {
    const text = String(req.body?.text ?? '').slice(0, 2000);
    const catalogInput = CatalogSchema.safeParse(req.body?.catalog ?? {});
    const catalog = catalogInput.success ? catalogInput.data : { services: [], barbers: [] };

    // 1) Construye un prompt que incluya el catálogo por NOMBRE para guiar al LLM
    const servicesList = catalog.services.map(s => `- ${s.id}: ${s.name}${s.synonyms?.length ? ` (sinónimos: ${s.synonyms.join(', ')})` : ''}`).join('\n');
    const barbersList  = catalog.barbers.map(b => `- ${b.id}: ${b.name}`).join('\n');

    const PLANNER_SYSTEM = `
Eres el planificador de la barbería VIP Stylist.
Debes devolver SOLO un JSON válido (sin explicaciones) con este formato:

{
  "intent": "create_appointment|get_next_appointment|search_services|small_talk",
  "args": {
    "barber": <id numérico o null>,
    "appointment_date": "YYYY-MM-DD" o null,
    "start_time": "HH:mm:ss" o null,
    "end_time": "HH:mm:ss" o null,
    "services": [<ids numéricos o nombres exactos de servicios>]
  }
}

Catálogo actual (usa sólo estos):

Servicios:
${servicesList || '(sin servicios)'}

Barberos:
${barbersList || '(sin barberos)'}

Reglas:
- Si es crear cita y no estás seguro de algún id, puedes usar el NOMBRE del servicio o del barbero; el servidor mapeará a ID.
- Si el usuario pide un servicio o barbero que NO exista en el catálogo, deja null (barber) o deja el nombre en services para que el servidor lo intente mapear; si no se puede mapear, el array quedará vacío.
- Fechas: YYYY-MM-DD. Horas: HH:mm:ss (24h).
- Si falta algo, pon null. No inventes.
- No devuelvas nada fuera del JSON.
`;

    // 2) Llama al planner
    const plan = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: text }
      ]
    });

    const raw = plan.choices?.[0]?.message?.content?.trim() || '{}';
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```$/,'');
    let parsed = IntentSchema.safeParse(JSON.parse(jsonStr));
    if (!parsed.success) {
      // fallback: small talk
      const talk = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.6,
        messages: [
          { role: 'system', content: 'Conversación breve y cálida en español para un cliente de barbería.' },
          { role: 'user', content: text }
        ]
      });
      const content = talk.choices?.[0]?.message?.content ?? '🙂';
      return res.json({ ok: true, mode: 'small_talk', content });
    }

    const data = parsed.data;

    // 3) Post-procesar/matchear determinísticamente con el catálogo (IDs válidos)
    const serviceIds = mapServicesToIds(data.args.services ?? [], catalog.services);
    const barberId = mapBarberToId(data.args.barber ?? null, catalog.barbers);

    // 4) Responder en formato de negocio para tu frontend
    return res.json({
      ok: true,
      mode: data.intent === 'small_talk' ? 'small_talk' : 'business',
      intent: data.intent,
      args: {
        barber: barberId ?? null,
        appointment_date: data.args.appointment_date ?? null,
        start_time: data.args.start_time ?? null,
        end_time: data.args.end_time ?? null,
        services: serviceIds // ya mapeados a ID si coincidieron
      },
      // útil para debugging/slot-filling en front:
      meta: {
        unmatchedServices: (data.args.services ?? []).filter(s => typeof s === 'string' && !serviceIds.length),
      }
    });

  } catch (e) {
    console.error('Groq error:', e?.response?.data || e?.message || e);
    res.status(500).json({ ok: false, error: 'Fallo en el servicio de IA (Groq)' });
  }
});

const port = process.env.PORT || 7070;
app.listen(port, () => {
  console.log(`Assistant IA (Groq) en http://localhost:${port}`);
});

import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';
import { z } from 'zod';

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 1) Schema para validar lo que devuelve el planner
const IntentSchema = z.object({
  intent: z.enum(['create_appointment', 'get_next_appointment', 'search_services', 'small_talk']),
  args: z.record(z.any()).default({})
});

// 2) Prompt del “planner”: debe devolver SOLO JSON
const PLANNER_SYSTEM = `
Eres un planificador para la barbería VIP Stylist.
Devuelve EXCLUSIVAMENTE un JSON válido (sin texto extra) con:
{"intent":"create_appointment|get_next_appointment|search_services|small_talk","args":{...}}

Reglas:
- Si el usuario solo conversa (saludo, dudas generales), usa "small_talk".
- Para crear cita: "create_appointment" y coloca en args: { "service":string, "date":string, "time":string, "barber":string? }.
- Si falta algún campo, pon null en ese campo. No inventes.
- Usa español.
`;

app.get('/', (_req, res) => res.send('Assistant IA up ✅. Use POST /chat'));

// 3) /chat ahora: primero capta intención, luego decide si charla o negocio
app.post('/chat', async (req, res) => {
  try {
    const text = String(req.body?.text ?? '').slice(0, 2000);

    // a) Pedimos al modelo SOLO el JSON de intención
    const plan = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: text }
      ]
    });

    const raw = plan.choices?.[0]?.message?.content?.trim() || '{}';

    // por si viniera envuelto en ```json ... ```
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```$/,'');
    let parsed = null;
    try {
      parsed = IntentSchema.parse(JSON.parse(jsonStr));
    } catch {
      // si falló el parse/validación, tratamos como small talk
      parsed = { intent: 'small_talk', args: {} };
    }

    // b) Si es small talk → pedimos respuesta natural
    if (parsed.intent === 'small_talk') {
      const talk = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        temperature: 0.6,
        messages: [
          { role: 'system', content: 'Conversación breve, cálida y útil para un cliente de una barbería. Responde en español.' },
          { role: 'user', content: text }
        ]
      });

      const content = talk.choices?.[0]?.message?.content ?? '🙂';
      return res.json({ ok: true, mode: 'small_talk', content });
    }

    // c) Si es intención de negocio, por ahora solo devolvemos el JSON capturado.
    // (En el próximo paso llamamos a tu backend con estos args.)
    return res.json({
      ok: true,
      mode: 'business',
      intent: parsed.intent,
      args: parsed.args,
      content: `He detectado intención: ${parsed.intent}.`
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

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import Groq from 'groq-sdk';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: true }));



// ====== LLM CLIENT: GROQ ======
const USE_LLM = !!process.env.GROQ_API_KEY;
const MODEL = process.env.MODEL || 'llama-3.1-8b-instant';
const groq = USE_LLM ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// ====== Utilidades ======
const STEPS = new Set(['selectServices', 'selectBarber', 'pickDate', 'viewSlots', 'confirm', 'done']);

function safeStr(x) {
  return typeof x === 'string' ? x : '';
}
function isPlainObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function fallbackByStep({ step, system_hint, context }) {
  const ctx = context || {};
  switch (step) {
    case 'selectServices':
      return '¿Qué servicios deseas? Responde con los números de la lista, por ejemplo: "1, 3".';
    case 'selectBarber':
      return 'Perfecto. Elige un barbero de la lista escribiendo su número (ejemplo: "2").';
    case 'pickDate':
      return 'Indícame la fecha en formato YYYY-MM-DD. Ejemplo: 2025-09-20.';
    case 'viewSlots':
      if (Array.isArray(ctx.slots) && ctx.slots.length) {
        const lines = ctx.slots.slice(0, 9).map((s, i) => `${i + 1}) ${s.start_time}–${s.end_time}`).join('\n');
        return `Horarios disponibles:\n${lines}\n\nResponde con el número de tu preferencia.`;
      }
      return 'No hay horarios disponibles para esa fecha. ¿Deseas intentar con otro día?';
    case 'confirm': {
      const { barber_id, date, start_time, end_time, service_count } = ctx;
      const serviciosTxt = service_count ? `${service_count} servicio(s)` : 'los servicios seleccionados';
      return `Confirmo: ${serviciosTxt}, barbero #${barber_id}, el ${date} de ${start_time} a ${end_time}. ¿Deseas confirmar? (sí/no)`;
    }
    case 'done':
      return '¡Tu cita fue creada correctamente! ¿Necesitas algo más?';
    default:
      return safeStr(system_hint) || '¿Podrías indicarme el siguiente dato, por favor?';
  }
}

function systemPrompt() {
  return `
Eres el asistente conversacional de "VIP Stylist / Alex Barbershop".
Tu función: convertir instrucciones estructuradas en un texto breve y amable en español.
NO inventes datos, NO cambies pasos, NO tomes decisiones de negocio.
`;
}

function userPrompt({ step, system_hint, context }) {
  const ctxJson = JSON.stringify(context ?? {}, null, 2);
  return `
Paso actual: ${step}
Instrucción: ${system_hint || '(sin hint)'}
Contexto JSON:
${ctxJson}

Redacta una respuesta corta en español, clara y natural.
`;
}

// ====== Endpoints ======
app.get('/health', (_req, res) => {
  res.json({ ok: true, provider: USE_LLM ? 'groq' : 'fallback', model: USE_LLM ? MODEL : 'templates' });
});

app.post('/chat', async (req, res) => {
  try {
    const { text, meta } = req.body || {};
    if (!isPlainObject(meta)) return res.status(400).json({ error: 'meta es requerido' });

    const step = safeStr(meta.step);
    const system_hint = safeStr(meta.system_hint);
    const context = isPlainObject(meta.context) ? meta.context : {};

    if (!STEPS.has(step)) console.warn('[WARN] step no estándar:', step);

    // Si no hay LLM, fallback
    if (!USE_LLM) {
      return res.json({ content: fallbackByStep({ step, system_hint, context }), provider: 'fallback' });
    }

    // ====== LLM con Groq ======
    const response = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 160,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt({ step, system_hint, context }) }
      ]
    });

    const content =
      response?.choices?.[0]?.message?.content?.trim() ||
      fallbackByStep({ step, system_hint, context });

    res.json({ content, provider: 'groq', model: MODEL });
  } catch (err) {
    console.error('[CHAT][ERROR]', err);
    const meta = isPlainObject(req.body?.meta) ? req.body.meta : {};
    const content = fallbackByStep({
      step: safeStr(meta.step),
      system_hint: safeStr(meta.system_hint),
      context: isPlainObject(meta.context) ? meta.context : {}
    });
    res.json({ content, provider: 'fallback' });
  }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Assistant server (Groq) on :${PORT}`));

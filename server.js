import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import Groq from 'groq-sdk';

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.get('/', (_req, res) => res.send('Assistant IA up ✅. Use POST /chat'));

app.post('/chat', async (req, res) => {
  try {
    const text = String(req.body?.text ?? '').slice(0, 2000);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant', // rápido y gratuito para pruebas
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'Eres el asistente de la barbería VIP Stylist. Responde en español y breve.' },
        { role: 'user', content: text }
      ]
    });

    const content = completion.choices?.[0]?.message?.content ?? 'Sin respuesta.';
    res.json({ ok: true, content });
  } catch (e) {
    console.error('Groq error:', e?.response?.data || e?.message || e);
    res.status(500).json({ ok: false, error: 'Fallo en el servicio de IA (Groq)' });
  }
});

const port = process.env.PORT || 7070;
app.listen(port, () => {
  console.log(`Assistant IA (Groq) en http://localhost:${port}`);
});

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey']
}));
app.use(express.json());

// Inicializar Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

// ============ RUTAS ============

// Ruta de bienvenida
app.get('/', (req, res) => {
  res.json({
    message: '❤️ LoveBite AI Backend está funcionando',
    status: 'online',
    endpoints: [
      'GET  /api/health',
      'POST /api/roulette',
      'POST /api/battle/start',
      'POST /api/battle/vote',
      'POST /api/judge',
      'POST /api/planner/suggest',
      'GET  /api/memories',
      'POST /api/memories',
      'POST /api/gifts'
    ]
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ 1. RUELETA ============
app.post('/api/roulette', async (req, res) => {
  try {
    const { type, budget, time, distance, mood } = req.body;
    const prompt = `
      Genera 3 opciones para ${type} (comida, actividad, película o lugar).
      Filtros:
      - Presupuesto: ${budget || 'sin límite'}
      - Tiempo disponible: ${time || 'sin especificar'}
      - Distancia: ${distance || 'sin especificar'}
      - Estado de ánimo: ${mood || 'cualquiera'}
      
      Devuelve solo un JSON con este formato:
      { "options": ["opción 1", "opción 2", "opción 3"] }
    `;
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const clean = response.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al generar opciones' });
  }
});

// ============ 2. FOOD BATTLE ============
app.post('/api/battle/start', async (req, res) => {
  try {
    const { optionA, optionB, type } = req.body;
    const { data, error } = await supabase
      .from('battles')
      .insert([{
        couple_id: req.body.coupleId || 'demo',
        option_a: optionA,
        option_b: optionB,
        type: type || 'food',
        rounds: 0,
        scores: { optionA: 0, optionB: 0 },
        status: 'active'
      }])
      .select()
      .single();
    if (error) throw error;
    res.json({ battleId: data.id, status: 'active' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al iniciar batalla' });
  }
});

app.post('/api/battle/vote', async (req, res) => {
  try {
    const { battleId, selected, userId, coupleId } = req.body;
    
    // Obtener batalla actual
    const { data: battle, error: getError } = await supabase
      .from('battles')
      .select('*')
      .eq('id', battleId)
      .single();
    if (getError) throw getError;

    const scores = battle.scores || { optionA: 0, optionB: 0 };
    const round = battle.rounds + 1;

    // Actualizar puntaje
    if (selected === 'A') scores.optionA += 1;
    else scores.optionB += 1;

    // Si ya son 5 rondas, terminar
    let status = 'active';
    let winner = null;
    if (round >= 5) {
      status = 'finished';
      winner = scores.optionA > scores.optionB ? battle.option_a : battle.option_b;
      if (scores.optionA === scores.optionB) winner = 'empate';
    }

    // Guardar voto en tabla de votos (opcional)
    const { error: voteError } = await supabase
      .from('battle_votes')
      .insert([{
        battle_id: battleId,
        user_id: userId,
        round: round,
        selected: selected
      }]);
    if (voteError) console.error('Error guardando voto:', voteError);

    // Actualizar batalla
    const { data: updated, error: updateError } = await supabase
      .from('battles')
      .update({
        rounds: round,
        scores: scores,
        status: status,
        winner: winner
      })
      .eq('id', battleId)
      .select()
      .single();
    if (updateError) throw updateError;

    // Si aún está activa, generar nueva pregunta con IA
    let questionData = null;
    if (status === 'active') {
      const prompt = `
        Estamos en la ronda ${round} de una batalla entre:
        A: ${battle.option_a}
        B: ${battle.option_b}
        Puntajes: ${JSON.stringify(scores)}
        
        Genera una pregunta para esta ronda (ej: "¿Cuál es más romántica?").
        Luego da un argumento breve a favor de A y otro a favor de B.
        Devuelve JSON:
        {
          "question": "...",
          "argumentA": "...",
          "argumentB": "..."
        }
      `;
      const result = await model.generateContent(prompt);
      const response = result.response.text();
      const clean = response.replace(/```json|```/g, '').trim();
      questionData = JSON.parse(clean);
    }

    res.json({
      battle: updated,
      questionData: questionData,
      scores: scores,
      winner: winner
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al procesar voto' });
  }
});

// ============ 3. JUDGE AI ============
app.post('/api/judge', async (req, res) => {
  try {
    const { optionA, optionB, argumentsA, argumentsB } = req.body;
    const prompt = `
      Una pareja no se pone de acuerdo entre:
      A: ${optionA} (argumentos: ${argumentsA})
      B: ${optionB} (argumentos: ${argumentsB})
      
      Eres el árbitro. Emite un veredicto justo y divertido.
      Puedes decidir por una opción o proponer un compromiso creativo.
      Devuelve JSON:
      {
        "verdict": "opción elegida o compromiso",
        "reason": "explicación breve y simpática",
        "compromise": "si aplica, descripción del compromiso"
      }
    `;
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const clean = response.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al generar veredicto' });
  }
});

// ============ 4. SMART PLANNER ============
app.post('/api/planner/suggest', async (req, res) => {
  try {
    const { history, preferences, budget } = req.body;
    const prompt = `
      Historial de comidas recientes: ${JSON.stringify(history || [])}
      Preferencias: ${JSON.stringify(preferences || {})}
      Presupuesto: ${budget || 500}
      
      Sugiere una comida que no se haya repetido en los últimos 3 días,
      que se ajuste al presupuesto y que sea variada.
      Devuelve JSON: { "meal": "nombre", "reason": "por qué", "restaurant": "opcional" }
    `;
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const clean = response.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al generar sugerencia' });
  }
});

// ============ 5. MEMORIAS ============
app.get('/api/memories', async (req, res) => {
  try {
    const { coupleId } = req.query;
    if (!coupleId) return res.status(400).json({ error: 'coupleId requerido' });
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('couple_id', coupleId)
      .order('date', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener recuerdos' });
  }
});

app.post('/api/memories', async (req, res) => {
  try {
    const { coupleId, userId, title, description, date, location, category, photoUrl } = req.body;
    const { data, error } = await supabase
      .from('memories')
      .insert([{
        couple_id: coupleId,
        user_id: userId,
        title,
        description,
        date: date || new Date().toISOString().split('T')[0],
        location: location || '',
        category: category || 'general',
        photo_url: photoUrl || ''
      }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear recuerdo' });
  }
});

// ============ 6. REGALOS ============
app.post('/api/gifts', async (req, res) => {
  try {
    const { preferences, budget } = req.body;
    const prompt = `
      Basado en estas preferencias: ${JSON.stringify(preferences || {})}
      Presupuesto: ${budget || 'sin límite'}
      
      Genera 3 ideas de regalo personalizadas, detalladas y originales.
      Devuelve JSON: { "ideas": [ { "name": "...", "description": "...", "price": "..." } ] }
    `;
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const clean = response.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al generar regalos' });
  }
});

// ============ INICIO ============
app.listen(PORT, () => {
  console.log(`🚀 LoveBite Backend running on port ${PORT}`);
});

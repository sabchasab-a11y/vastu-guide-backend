require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ═══════════════════════════════════════════════════════════════
// PROMPT BUILDERS — one per plan type
// ═══════════════════════════════════════════════════════════════

function buildFreePrompt(roomData) {
  const rooms = [
    roomData.entrance && `Main Entrance: ${roomData.entrance}`,
    roomData.masterBedroom && `Master Bedroom: ${roomData.masterBedroom}`,
    roomData.bathroom && `Bathroom: ${roomData.bathroom}`,
  ].filter(Boolean).join(', ');

  return `Quick Vastu analysis for: ${rooms}

Return ONLY valid JSON (no markdown):
{
  "score": <0-100>,
  "grade": "Good/Fair/Needs Attention",
  "summary": "<1-2 sentences on overall Vastu status>",
  "issues": [
    {"title": "<issue>", "remedy": "<solution>"}
  ],
  "recommendations": [
    {"title": "<action>", "detail": "<instruction>"}
  ]
}`;
}

function buildStandardPrompt(roomData) {
  const rooms = [
    roomData.entrance && `Entrance: ${roomData.entrance}`,
    roomData.kitchen && `Kitchen: ${roomData.kitchen}`,
    roomData.masterBedroom && `Master Bedroom: ${roomData.masterBedroom}`,
    roomData.bathroom && `Bathroom: ${roomData.bathroom}`,
    roomData.livingRoom && `Living Room: ${roomData.livingRoom}`,
    roomData.pooja && `Pooja Room: ${roomData.pooja}`,
  ].filter(Boolean).join(', ');

  return `Vastu analysis for: ${rooms}

Return ONLY valid JSON:
{
  "score": <0-100>,
  "grade": "Excellent/Good/Fair/Needs Attention",
  "summary": "<2-3 sentences on Vastu status>",
  "rooms": [
    {"name": "<room>", "direction": "<dir>", "status": "good/caution/defect"}
  ],
  "issues": [
    {"title": "<problem>", "severity": "major/minor", "remedy": "<solution>"}
  ],
  "recommendations": [
    {"title": "<action>", "detail": "<instruction>"}
  ]
}`;
}

function buildDetailedPrompt(roomData) {
  const rooms = [
    roomData.entrance && `Main Entrance: faces ${roomData.entrance}`,
    roomData.kitchen && `Kitchen: located in the ${roomData.kitchen} zone`,
    roomData.masterBedroom && `Master Bedroom: located in the ${roomData.masterBedroom} zone`,
    roomData.bathroom && `Bathroom/Toilet: located in the ${roomData.bathroom} zone`,
    roomData.livingRoom && `Living Room: located in the ${roomData.livingRoom} zone`,
    roomData.pooja && `Pooja Room: located in the ${roomData.pooja} zone`,
  ].filter(Boolean).join('\n');

  return `You are a senior Vastu Shastra expert. Provide a DETAILED analysis.

Property: ${roomData.propertyName || 'Residential Property'}
Room placements:
${rooms}

Return ONLY a valid JSON object (no markdown). Keep responses CONCISE:
{
  "score": <0-100>,
  "grade": "<Excellent|Good|Fair|Needs Attention|Poor>",
  "propertyName": "${roomData.propertyName || 'My Home'}",
  "overallSummary": "<2-3 sentences summarizing Vastu assessment>",
  "rooms": [
    {"room": "<name>", "direction": "<dir>", "status": "<good|caution|defect>", "note": "<brief assessment>"}
  ],
  "issues": [
    {"zone": "<zone>", "title": "<title>", "description": "<brief description>", "severity": "<critical|major|minor>", "remedy": "<practical remedy>"}
  ],
  "recommendations": [
    {"title": "<action>", "detail": "<specific instruction>"}
  ]
}

Limit to 5 rooms, 4 issues, 3 recommendations. Be concise and practical.`;
}

function buildFloorPlanPrompt(mimeType) {
  return `You are a senior Vastu Shastra expert specializing in architectural analysis. Carefully examine this floor plan.

This is an actual architectural floor plan. Analyze every visible element:
- Room positions, shapes, and proportions
- Entrance/door placements
- Kitchen, bathroom, bedroom locations
- Staircase position (if visible)
- Plot shape (extensions, cuts)
- Brahmasthan (center of the plot)
- Open spaces and courtyards

Return ONLY a valid JSON object. Schema:
{
  "score": <0-100 integer>,
  "grade": "<Excellent|Good|Fair|Needs Attention|Poor>",
  "propertyName": "Floor Plan Analysis",
  "overallSummary": "<4-5 sentences: comprehensive architectural Vastu assessment>",
  "elementMapping": {
    "Earth (Prithvi)": { "icon": "🌍", "zone": "South-West (Nairutya)", "balanced": <true|false>, "note": "<assessment>" },
    "Water (Jal)": { "icon": "💧", "zone": "North-East (Ishanya)", "balanced": <true|false>, "note": "<assessment>" },
    "Fire (Agni)": { "icon": "🔥", "zone": "South-East (Agneya)", "balanced": <true|false>, "note": "<assessment>" },
    "Air (Vayu)": { "icon": "💨", "zone": "North-West (Vayavya)", "balanced": <true|false>, "note": "<assessment>" },
    "Space (Akasha)": { "icon": "✨", "zone": "Center (Brahmasthan)", "balanced": <true|false>, "note": "<assessment>" }
  },
  "rooms": [
    {
      "room": "<detected room>",
      "icon": "<emoji>",
      "direction": "<direction from center with Sanskrit name>",
      "status": "<excellent|good|caution|defect>",
      "summary": "<detailed Vastu analysis of this room's position, proportion, and placement>",
      "positives": ["<positive>"],
      "issues": [
        { "problem": "<specific structural Vastu defect>", "remedy": "<detailed remedy>" }
      ]
    }
  ],
  "issues": [
    {
      "zone": "<zone>",
      "title": "<title>",
      "description": "<detailed explanation including structural impact>",
      "severity": "<critical|major|minor>",
      "remedy": "<detailed structural or non-structural remedy>"
    }
  ],
  "strengths": [
    { "title": "<strength>", "detail": "<explanation>" }
  ],
  "recommendations": [
    {
      "title": "<title>",
      "detail": "<very specific instruction with measurements, colours, materials where applicable>",
      "timing": "<auspicious timing>"
    }
  ]
}

Be extremely specific about what you see in the floor plan. Mention exact rooms, their positions, and precise Vastu violations or compliances.`;
}

// ═══════════════════════════════════════════════════════════════
// POST /api/analyze
// ═══════════════════════════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { planType, roomData, base64, mimeType } = req.body;

  if (!planType) return res.status(400).json({ success: false, error: 'Missing planType' });

  let messages;
  let prompt;

  if (planType === 'floorplan') {
    if (!base64 || !mimeType) return res.status(400).json({ success: false, error: 'Missing floor plan file' });
    const isPDF = mimeType === 'application/pdf';
    const filePart = isPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
    prompt = buildFloorPlanPrompt(mimeType);
    messages = [{ role: 'user', content: [filePart, { type: 'text', text: prompt }] }];
  } else {
    if (!roomData) return res.status(400).json({ success: false, error: 'Missing room data' });
    if (planType === 'free') {
      prompt = buildFreePrompt(roomData);
    } else if (planType === 'standard') {
      prompt = buildStandardPrompt(roomData);
    } else {
      prompt = buildDetailedPrompt(roomData);
    }
    messages = [{ role: 'user', content: prompt }];
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: planType === 'free' ? 1000 : planType === 'standard' ? 1800 : 2500,
      system: 'You are a Vastu Shastra expert. Return ONLY valid JSON. Start with { and end with }. No markdown fences, no preamble.',
      messages,
    });

    const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Try to parse JSON with multiple strategies
    let parsed;
    
    // Strategy 1: Direct parse
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Strategy 2: Remove markdown fences
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // Strategy 3: Extract JSON object from text
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
          throw new Error('No JSON found in response');
        }
        
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // Strategy 4: Fix common JSON issues
          let fixed = match[0]
            .replace(/,\s*\]/g, ']')  // Remove trailing commas in arrays
            .replace(/,\s*\}/g, '}')  // Remove trailing commas in objects
            .replace(/:\s*undefined/g, ': null')  // Fix undefined values
            .replace(/:\s*NaN/g, ': 0');  // Fix NaN values
          
          parsed = JSON.parse(fixed);
        }
      }
    }

    res.json({ success: true, result: parsed });
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ success: false, error: 'Analysis failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/verify-purchase
// ═══════════════════════════════════════════════════════════════
app.post('/api/verify-purchase', async (req, res) => {
  const { productId, purchaseToken, packageName } = req.body;
  if (!productId || !purchaseToken || !packageName) {
    return res.status(400).json({ success: false, error: 'Missing purchase details' });
  }

  try {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const publisher = google.androidpublisher({ version: 'v3', auth });

    const { data: purchase } = await publisher.purchases.products.get({ packageName, productId, token: purchaseToken });

    if (purchase.purchaseState !== 0) return res.status(400).json({ success: false, error: 'Purchase not completed' });
    if (purchase.consumptionState !== 0) return res.status(400).json({ success: false, error: 'Already consumed' });

    await publisher.purchases.products.acknowledge({ packageName, productId, token: purchaseToken });

    res.json({ success: true });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ success: false, error: 'Purchase verification failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0' }));

app.listen(PORT, () => console.log(`Vastu Guide v2 backend on port ${PORT}`));

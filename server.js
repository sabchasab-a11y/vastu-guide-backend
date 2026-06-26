require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.raw({ type: 'image/*', limit: '10mb' }));
app.use(express.raw({ type: 'application/pdf', limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION (Check if user has valid purchase)
// ═══════════════════════════════════════════════════════════════════════════════

async function verifyPurchaseValid(productId, purchaseToken, packageName) {
  try {
    if (!purchaseToken || purchaseToken === 'free') {
      return { isPaid: false, isValid: true }; // Free plan - no verification needed
    }

    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const publisher = google.androidpublisher({ version: 'v3', auth });

    const { data: purchase } = await publisher.purchases.products.get({ 
      packageName, 
      productId, 
      token: purchaseToken 
    });

    // Check if purchase is valid and not consumed
    const isValid = purchase.purchaseState === 0 && purchase.consumptionState === 0;
    
    return { isPaid: isValid, isValid };
  } catch (err) {
    console.error('Purchase verification error:', err.message);
    return { isPaid: false, isValid: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAN LIMITS - Enforce what each plan can do
// ═══════════════════════════════════════════════════════════════════════════════

const PLAN_LIMITS = {
  free: {
    maxRooms: 3,
    maxIssues: 3,
    maxRecommendations: 2,
    allowFloorPlan: false,
  },
  standard: {
    maxRooms: 6,
    maxIssues: 5,
    maxRecommendations: 3,
    allowFloorPlan: false,
  },
  detailed: {
    maxRooms: 10,
    maxIssues: 8,
    maxRecommendations: 5,
    allowFloorPlan: false,
  },
  floorplan: {
    maxRooms: 100,
    maxIssues: 10,
    maxRecommendations: 10,
    allowFloorPlan: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// ENFORCE PLAN LIMITS - Trim results based on plan type
// ═══════════════════════════════════════════════════════════════════════════════

function enforcePlanLimits(result, planType) {
  const limits = PLAN_LIMITS[planType] || PLAN_LIMITS.free;

  // Enforce room limit
  if (result.rooms && Array.isArray(result.rooms)) {
    result.rooms = result.rooms.slice(0, limits.maxRooms);
  }

  // Enforce issue limit
  if (result.issues && Array.isArray(result.issues)) {
    result.issues = result.issues.slice(0, limits.maxIssues);
  }

  // Enforce recommendation limit
  if (result.recommendations && Array.isArray(result.recommendations)) {
    result.recommendations = result.recommendations.slice(0, limits.maxRecommendations);
  }

  // Add watermark for free plan
  if (planType === 'free') {
    result.planType = 'free';
    result.limitation = 'Free Trial - Limited to 3 rooms. Upgrade for full analysis.';
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/analyze - WITH PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/analyze', async (req, res) => {
  const { planType, roomData, base64, mimeType, purchaseToken, packageName, productId } = req.body;

  if (!planType) return res.status(400).json({ success: false, error: 'Missing planType' });

  // ════════════════════════════════════════════════════════════════════════════
  // PAYMENT CHECK - Verify user has paid (unless free trial)
  // ════════════════════════════════════════════════════════════════════════════
  
  if (planType !== 'free') {
    // For paid plans, verify purchase
    if (!purchaseToken || !productId || !packageName) {
      return res.status(403).json({ 
        success: false, 
        error: 'Payment verification failed. Please verify your purchase.' 
      });
    }

    const verification = await verifyPurchaseValid(productId, purchaseToken, packageName);
    
    if (!verification.isPaid) {
      return res.status(403).json({ 
        success: false, 
        error: 'Your purchase could not be verified. Please try again or contact support.' 
      });
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PROCESS ANALYSIS
  // ════════════════════════════════════════════════════════════════════════════

  let messages;
  let prompt;

  if (planType === 'floorplan') {
    if (!base64 || !mimeType) return res.status(400).json({ success: false, error: 'Missing floor plan file' });
    
    // Floor plan only available for paid plan
    if (!PLAN_LIMITS.floorplan.allowFloorPlan) {
      return res.status(403).json({ 
        success: false, 
        error: 'Floor plan analysis requires the Floor Plan package.' 
      });
    }

    const sizeInBytes = base64.length * 0.75;
    const sizeInMB = sizeInBytes / (1024 * 1024);
    if (sizeInMB > 5) {
      return res.status(413).json({ 
        success: false, 
        error: `File too large (${sizeInMB.toFixed(1)}MB). Maximum: 5MB.` 
      });
    }
    
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

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON found');
        
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          let fixed = match[0]
            .replace(/,\s*\]/g, ']')
            .replace(/,\s*\}/g, '}')
            .replace(/:\s*undefined/g, ': null')
            .replace(/:\s*NaN/g, ': 0');
          parsed = JSON.parse(fixed);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // ENFORCE PLAN LIMITS - This is the KEY FIX!
    // ════════════════════════════════════════════════════════════════════════
    
    parsed = enforcePlanLimits(parsed, planType);

    res.json({ success: true, result: parsed });
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ success: false, error: 'Analysis failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/verify-purchase
// ═══════════════════════════════════════════════════════════════════════════════

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

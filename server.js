
require("dotenv").config();

const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();

const PORT = process.env.PORT || 3000;
const OLLAMA_URL = "https://ollama.com";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma3:1b";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));
let db = null;
let mongoClient = null;

// Connect to MongoDB if a connection string is provided.
async function connectDatabase() {
    const uri = process.env.MONGODB_URI;

    if (!uri || uri.includes("paste_your_mongodb")) {
        console.log("MongoDB not configured. Running without database.");
        return;
    }

    try {
        mongoClient = new MongoClient(uri, {
            serverSelectionTimeoutMS: 5000
        });

        await mongoClient.connect();

        db = mongoClient.db(process.env.MONGODB_DB || "errorbuddy");

        console.log("MongoDB connected!");
    } catch (error) {
        console.log("MongoDB connection failed. Running without database.");
        console.log(error.message);

        if (mongoClient) {
            await mongoClient.close().catch(() => {});
            mongoClient = null;
        }

        db = null;
    }
}

function getCollection(name) {
    return db ? db.collection(name) : null;
}

// Check if the server is running.
app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        model: OLLAMA_MODEL,
        database: db ? "connected" : "not connected"
    });
});

// Get saved preferences.
app.get("/api/preferences/:userId", async (req, res) => {
    try {
        const collection = getCollection("preferences");

        if (!collection) {
            return res.json({ preferences: {} });
        }

        const saved = await collection.findOne({
            userId: req.params.userId
        });

        res.json({ preferences: saved?.preferences || {} });
    } catch (error) {
        res.status(500).json({ error: "Could not load preferences." });
    }
});

// Save preferences.
app.put("/api/preferences/:userId", async (req, res) => {
    try {
        const collection = getCollection("preferences");
        const preferences = req.body.preferences || req.body;

        if (collection) {
            await collection.updateOne(
                { userId: req.params.userId },
                {
                    $set: {
                        userId: req.params.userId,
                        preferences,
                        updatedAt: new Date()
                    }
                },
                { upsert: true }
            );
        }

        res.json({
            success: true,
            preferences
        });
    } catch (error) {
        res.status(500).json({ error: "Could not save preferences." });
    }
});

// Analyze an error or answer a follow-up question.
app.post("/api/analyze", async (req, res) => {
    try {
        const {
            userId = "guest",
            error = "",
            code = "",
            language = "Auto-detect",
            preferences = {},
            answerStyle = "Simple",
            explanationLevel = "Beginner",
            followUp = "",
            previousAnswer = ""
        } = req.body;

        if (!error.trim() && !code.trim() && !followUp.trim()) {
            return res.status(400).json({
                error: "Please enter an error message, code, or follow-up question."
            });
        }

const systemPrompt = `
You are ErrorBuddy AI, a concise programming debugger.

STRICT RULES:
- Keep the entire answer under 100 words.
- Use simple, beginner-friendly English.
- Never repeat the same point.
- Explain only the actual error and its solution.
- Show only the corrected code needed.
- Do not add unnecessary introductions or conclusions.
- Ask at most ONE follow-up question, only if essential.
- Prevention tip must be one short sentence.
- Do not invent details or claim code was tested.

Return ONLY valid JSON:
{
  "answer": "Cause in 1-2 sentences, followed by the fix and a short code example if useful.",
  "severity": "low, medium, high, or critical",
  "confidence": "low, medium, or high",
  "preventionTip": "One short prevention tip."
}
`;

        const userPrompt = `
Programming language: ${language}
Answer style: ${answerStyle}
Explanation level: ${explanationLevel}
Additional preferences: ${JSON.stringify(preferences)}

Error message:
${error || "(No error message provided)"}

Code:
${code || "(No code provided)"}

Previous AI answer:
${previousAnswer || "(No previous answer)"}

Follow-up question:
${followUp || "(Initial error analysis)"}

Please diagnose the issue and answer the follow-up if one was provided.
`;

headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OLLAMA_API_KEY}`
},
        method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                stream: false,
                format: "json",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
               options: {
    temperature: 0.1,
    num_predict: 180
}
            })
        });

        if (!ollamaResponse.ok) {
            const details = await ollamaResponse.text();

            return res.status(502).json({
                error: "Could not get a response from Ollama. Make sure Ollama is running and the model is installed.",
                details
            });
        }

        const ollamaData = await ollamaResponse.json();
        const rawAnswer = ollamaData.message?.content || "";

        let result;

        try {
            result = JSON.parse(rawAnswer);
        } catch {
            result = {
                answer: rawAnswer || "I could not generate an answer. Please try again.",
                severity: "medium",
                confidence: "low",
                preventionTip: "Check the error message and code carefully."
            };
        }

        const allowedSeverities = ["low", "medium", "high", "critical"];
        const allowedConfidence = ["low", "medium", "high"];

        if (!allowedSeverities.includes(result.severity)) {
            result.severity = "medium";
        }

        if (!allowedConfidence.includes(result.confidence)) {
            result.confidence = "low";
        }

        result.answer = String(result.answer || "No explanation was generated.");
        result.preventionTip = String(result.preventionTip || "");

        // Save analysis history when MongoDB is connected.
        const history = getCollection("history");

        if (history) {
            await history.insertOne({
                userId,
                error,
                code,
                language,
                followUp,
                answer: result.answer,
                severity: result.severity,
                confidence: result.confidence,
                preventionTip: result.preventionTip,
                createdAt: new Date()
            });
        }

        res.json(result);
    } catch (error) {
        console.error("Analysis error:", error.message);

        res.status(500).json({
            error: "Something went wrong while analyzing the code. Check that Ollama is running."
        });
    }
});

// Get recent error history.
app.get("/api/history/:userId", async (req, res) => {
    try {
        const collection = getCollection("history");

        if (!collection) {
            return res.json({ history: [] });
        }

        const history = await collection
            .find({ userId: req.params.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();

        res.json({ history });
    } catch (error) {
        res.status(500).json({ error: "Could not load error history." });
    }
});

// Serve the frontend for the root URL.
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function startServer() {
    await connectDatabase();

    app.listen(PORT, () => {
        console.log(`ErrorBuddy AI is running at http://localhost:${PORT}`);
        console.log(`Using Ollama model: ${OLLAMA_MODEL}`);
    });
}

startServer();

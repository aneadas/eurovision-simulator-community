const admin = require('firebase-admin');

// Helper to safely get DB instance
function getDb() {
    try {
        if (!admin.apps.length) {
            if (process.env.FIREBASE_SERVICE_ACCOUNT) {
                try {
                    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                    admin.initializeApp({
                        credential: admin.credential.cert(serviceAccount)
                    });
                } catch (e) {
                    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT", e);
                    // Try default as fallback
                    admin.initializeApp();
                }
            } else {
                // Try default init
                admin.initializeApp();
            }
        }
        return admin.firestore();
    } catch (e) {
        console.error("Firebase Init Error:", e);
        return null;
    }
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { action } = req.query; // For GET requests
    const body = req.body || {};
    const effectiveAction = action || body.action;

    try {
        const db = getDb();

        // --- LEADERBOARD ---
        if (effectiveAction === 'getLeaderboard') {
            if (!db) {
                // Return Demo Data if Firebase is not configured
                return res.status(200).json({
                    countries: [
                        { country: 'Sweden', code: 'se', wins: 127, juryWins: 80, teleWins: 50, lastPlaces: 2 },
                        { country: 'Italy', code: 'it', wins: 98, juryWins: 60, teleWins: 90, lastPlaces: 0 },
                        { country: 'Ukraine', code: 'ua', wins: 87, juryWins: 40, teleWins: 110, lastPlaces: 1 },
                        { country: 'United Kingdom', code: 'gb', wins: 48, juryWins: 55, teleWins: 20, lastPlaces: 15 },
                        { country: 'Germany', code: 'de', wins: 42, juryWins: 30, teleWins: 10, lastPlaces: 25 },
                    ],
                    totalSimulations: 892,
                    isDemo: true
                });
            }

            try {
                const snapshot = await db.collection('leaderboard').get();
                const countries = [];
                let totalSimulations = 0;

                snapshot.forEach(doc => {
                    if (doc.id === '_stats') {
                        totalSimulations = doc.data().totalSimulations || 0;
                    } else {
                        countries.push(doc.data());
                    }
                });
                return res.status(200).json({ countries, totalSimulations });
            } catch (err) {
                console.error("Error fetching leaderboard from Firestore:", err);
                return res.status(500).json({ error: "Database error" });
            }
        }

        if (effectiveAction === 'recordWin') {
            const { winnerCountry, winnerCode, results, sortedCountries } = body;


            if (!winnerCode) return res.status(400).json({ error: 'Missing winnerCode' });

            if (!db) {
                // Mock success for demo mode
                console.log("Mocking recordWin (Firebase unconnected)");
                return res.status(200).json({ success: true, mocked: true });
            }

            const batch = db.batch();

            // 1. Overall Winner
            const winnerRef = db.collection('leaderboard').doc(winnerCode);
            batch.set(winnerRef, {
                country: winnerCountry,
                code: winnerCode,
                wins: admin.firestore.FieldValue.increment(1),
                lastWin: new Date().toISOString()
            }, { merge: true });

            // 2. Statistics
            if (results && sortedCountries) {
                // Jelly Winner
                let juryWinner = sortedCountries[0];
                let maxJury = -1;
                sortedCountries.forEach(c => {
                    if (results[c].juryTotal > maxJury) {
                        maxJury = results[c].juryTotal;
                        juryWinner = c;
                    }
                });
                // Note: Client didn't send getCountryCode logic, so we rely on client or simplified logic. 
                // BUT wait, the client implementation relies on `getCountryCode` function. 
                // We should probably trust the client to send the codes or simply increment what we know.
                // However, the previous client logic calculated these ON THE CLIENT and then sent write ops.
                // It's safer if the CLIENT sends the calculated winner codes.
                // Adaptation: The client should send specific increments, or we replicate logic.
                // Replicating logic here is hard without `getCountryCode` mapping.
                // Let's assume the Client sends `juryWinnerCode`, `teleWinnerCode`, `lastPlaceCode`.

                if (body.juryWinnerCode) {
                    const juryRef = db.collection('leaderboard').doc(body.juryWinnerCode);
                    batch.set(juryRef, {
                        country: body.juryWinnerName,
                        code: body.juryWinnerCode,
                        juryWins: admin.firestore.FieldValue.increment(1)
                    }, { merge: true });
                }

                if (body.teleWinnerCode) {
                    const teleRef = db.collection('leaderboard').doc(body.teleWinnerCode);
                    batch.set(teleRef, {
                        country: body.teleWinnerName,
                        code: body.teleWinnerCode,
                        teleWins: admin.firestore.FieldValue.increment(1)
                    }, { merge: true });
                }

                if (body.lastPlaceCode) {
                    const lastRef = db.collection('leaderboard').doc(body.lastPlaceCode);
                    batch.set(lastRef, {
                        country: body.lastPlaceName,
                        code: body.lastPlaceCode,
                        lastPlaces: admin.firestore.FieldValue.increment(1)
                    }, { merge: true });
                }
            }

            // 5. Total Simulations
            const statsRef = db.collection('leaderboard').doc('_stats');
            batch.set(statsRef, {
                totalSimulations: admin.firestore.FieldValue.increment(1)
            }, { merge: true });

            await batch.commit();
            return res.status(200).json({ success: true });
        }

        // --- JESC VOTING ---
        // --- JESC VOTING ---
        if (effectiveAction === 'getJescData') {
            if (!db) {
                return res.status(200).json({ votesData: {}, totalVotes: 0, isDemo: true });
            }

            const { type } = req.query; // 'vote' or 'prediction'
            const collectionName = type === 'vote' ? 'jesc_2025_votes' : 'jesc_2025_predictions';

            try {
                const snapshot = await db.collection(collectionName).get();
                const votesData = {};
                let totalVotes = 0;

                snapshot.forEach(doc => {
                    votesData[doc.id] = doc.data().votes || 0;
                    totalVotes += doc.data().votes || 0;
                });

                return res.status(200).json({ votesData, totalVotes });
            } catch (err) {
                console.error("Error fetching JESC data:", err);
                return res.status(500).json({ error: "Database error" });
            }
        }

        if (effectiveAction === 'castJescVote') {
            const { countryCode, type } = body;


            if (!db) {
                return res.status(200).json({ success: true, mocked: true });
            }

            const collectionName = type === 'vote' ? 'jesc_2025_votes' : 'jesc_2025_predictions';

            try {
                const docRef = db.collection(collectionName).doc(countryCode);
                await docRef.set({
                    votes: admin.firestore.FieldValue.increment(1)
                }, { merge: true });
                return res.status(200).json({ success: true });
            } catch (err) {
                console.error("Error casting vote:", err);
                return res.status(500).json({ error: "Database error" });
            }
        }

        return res.status(400).json({ error: 'Invalid action' });
    } catch (error) {
        console.error("API Error", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

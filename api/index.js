const admin = require('firebase-admin');

// Initialize Firebase Admin
// On Vercel, you should set FIREBASE_SERVICE_ACCOUNT environment variable with the JSON content of your service account key.
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (e) {
            console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT", e);
            // Fallback for local testing if configured differently, or error out
            admin.initializeApp();
        }
    } else {
        // Fallback or implicit env (e.g. GOOGLE_APPLICATION_CREDENTIALS)
        admin.initializeApp();
    }
}

const db = admin.firestore();

export default async function handler(req, res) {
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
        // --- LEADERBOARD ---
        if (effectiveAction === 'getLeaderboard') {
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
        }

        if (effectiveAction === 'recordWin') {
            const { winnerCountry, winnerCode, results, sortedCountries } = body;

            if (!winnerCode) return res.status(400).json({ error: 'Missing winnerCode' });

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
        if (effectiveAction === 'getJescData') {
            const { type } = req.query; // 'vote' or 'prediction'
            const collectionName = type === 'vote' ? 'jesc_2025_votes' : 'jesc_2025_predictions';

            const snapshot = await db.collection(collectionName).get();
            const votesData = {};
            let totalVotes = 0;

            snapshot.forEach(doc => {
                votesData[doc.id] = doc.data().votes || 0;
                totalVotes += doc.data().votes || 0;
            });

            return res.status(200).json({ votesData, totalVotes });
        }

        if (effectiveAction === 'castJescVote') {
            const { countryCode, type } = body;
            if (!countryCode || !type) return res.status(400).json({ error: 'Missing params' });

            const collectionName = type === 'vote' ? 'jesc_2025_votes' : 'jesc_2025_predictions';

            const docRef = db.collection(collectionName).doc(countryCode);
            await docRef.set({
                votes: admin.firestore.FieldValue.increment(1)
            }, { merge: true });

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Invalid action' });
    } catch (error) {
        console.error("API Error", error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

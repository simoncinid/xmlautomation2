// index.js
const express = require('express');
const fetch = require('node-fetch'); // Se usi Node v18+, fetch è globale; altrimenti, usa node-fetch
const { DOMParser } = require('@xmldom/xmldom');

const pdfjsLib = require('pdfjs-dist'); // Per estrarre testo dai PDF

// Crea l'app Express
const app = express();
app.use(express.json());

// Carica le chiavi e URL da variabili d'ambiente (imposta queste variabili su Render)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // La tua chiave OpenAI
const WEBHOOK_URL = process.env.WEBHOOK_URL;         // L'URL del webhook a cui inviare i risultati

// Funzione per ottenere l'embedding da OpenAI
async function getEmbedding(text) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      input: text,
      model: "text-embedding-ada-002"
    })
  });
  if (!response.ok) {
    throw new Error("Errore durante il calcolo embedding: " + response.statusText);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

// Funzione per calcolare la similarità coseno tra due vettori
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    console.warn("Dimensioni diverse nei vettori embedding!");
    return 0;
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Funzione per estrarre il testo da un PDF usando pdfjs-dist
async function extractPdfText(pdfUrl) {
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error("Impossibile scaricare PDF: " + pdfUrl);
  }
  const arrayBuffer = await response.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    fullText += strings.join(" ") + "\n";
  }
  return fullText;
}

// Endpoint che riceve la POST da GoHighLevel
app.post('/api/process', async (req, res) => {
  try {
    // Estrai i dati dal payload ricevuto
    const {
      anno_costituzione,
      piva,
      controlla_altre_imprese,
      controllata_da_altre_imprese,
      particolarita,
      aspetti_da_migliorare,
      numero_dipendenti,
      forma_giuridica,
      fatturato,
      tipologia_azienda,
      dimensioni,
      codice_ateco
    } = req.body;

    // Combina i campi di testo per il matching
    const userText = (particolarita || "") + " " + (aspetti_da_migliorare || "");

    // Costruisci l'XML da inviare
    const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<Businesses>
  <Business>
    <AnnoCostituzione>${anno_costituzione}</AnnoCostituzione>
    <PIVA>${piva}</PIVA>
    <ControllaAltReImprese>${controlla_altre_imprese}</ControllaAltReImprese>
    <ControllataDaAltReImprese>${controllata_da_altre_imprese}</ControllataDaAltReImprese>
    <NumeroDipendenti>${numero_dipendenti}</NumeroDipendenti>
    <FatturatoUltimoEsercizio>${fatturato}</FatturatoUltimoEsercizio>
    <FormaGiuridica>${forma_giuridica}</FormaGiuridica>
    <Tipologia>${tipologia_azienda}</Tipologia>
    <DimensioniAzienda>${dimensioni}</DimensioniAzienda>
    <CodiceIstatAteco>${codice_ateco}</CodiceIstatAteco>
    <Particolarita>${userText}</Particolarita>
  </Business>
</Businesses>`;

    // Invia l'XML a un endpoint esterno
    const uploadResponse = await fetch("https://xmlautomation-rt2n.onrender.com/upload-xml", {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xmlPayload
    });
    if (!uploadResponse.ok) {
      throw new Error("Errore uploading XML: " + uploadResponse.statusText);
    }

    // Attendi 30 secondi per la generazione della risposta
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Recupera l'XML di risposta
    const responseXML = await fetch("https://www.geniabusiness.com/ingplan/xmlbandiazienda.asp");
    if (!responseXML.ok) {
      throw new Error("Errore fetching XML response: " + responseXML.statusText);
    }
    const xmlString = await responseXML.text();

    // Parse XML usando xmldom
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "application/xml");
    const bandiNodes = xmlDoc.getElementsByTagName("child");

    // Processa ogni "bando"
    const bandiInfo = [];
    for (let i = 0; i < bandiNodes.length; i++) {
      const node = bandiNodes[i];
      const nomebando = (node.getElementsByTagName("nomebando")[0]?.textContent) || "N/A";
      const schedacompleta = (node.getElementsByTagName("schedacompleta")[0]?.textContent) || "";
      let pdfText = "";
      if (schedacompleta && schedacompleta.endsWith(".pdf")) {
        // Costruisci l'URL del proxy per il PDF
        const pdfProxyUrl = "https://xmlautomation-rt2n.onrender.com/pdf-proxy?url=" + encodeURIComponent(schedacompleta);
        pdfText = await extractPdfText(pdfProxyUrl);
      }
      let pdfEmbedding = [];
      if (pdfText) {
        try {
          const truncatedText = pdfText.slice(0, 2000);
          pdfEmbedding = await getEmbedding(truncatedText);
        } catch (err) {
          console.warn("Errore embedding PDF per il bando " + i, err);
        }
      }
      // Ottieni embedding del testo utente
      const userEmbedding = await getEmbedding(userText);
      let score = 0;
      if (userEmbedding && pdfEmbedding.length > 0) {
        score = cosineSimilarity(userEmbedding, pdfEmbedding);
      }
      bandiInfo.push({ nomebando, schedacompleta, score });
    }

    // Ordina i bandi per score decrescente e seleziona i primi 3
    bandiInfo.sort((a, b) => b.score - a.score);
    const top3 = bandiInfo.slice(0, 3);

    // Invia i risultati (i 3 migliori bandi) al webhook
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bandi: top3 })
    });

    // Non è necessario restituire nulla a GoHighLevel
    res.status(200).json({ message: "Webhook inviato con successo." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Avvia il server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});

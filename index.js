// index.js
const express = require('express');
const cors = require('cors');  // <-- Assicurati di importare cors


const fetch = require('node-fetch'); // Se usi Node v18+, fetch è globale; altrimenti, usa node-fetch
const { DOMParser } = require('@xmldom/xmldom');
const pdfjsLib = require('pdfjs-dist');

const app = express();
app.use(express.json());
app.use(cors()); // <-- Questo abilita CORS per tutte le richieste
app.options('*', cors()); // Permette le richieste preflight su tutte le route
app.use(express.json()); // Middleware per JSON
// Variabili d'ambiente
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // La tua chiave OpenAI
const WEBHOOK_URL = process.env.WEBHOOK_URL;         // L'URL del webhook a cui inviare i risultati

// Funzione per ottenere l'embedding da OpenAI
async function getEmbedding(text) {
  console.log("Richiesta embedding per il testo:", text.substring(0, 50) + "...");
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
  console.log("Embedding ottenuto.");
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
  console.log("Estrazione del testo dal PDF:", pdfUrl);
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error("Impossibile scaricare PDF: " + pdfUrl);
  }
  const arrayBuffer = await response.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    console.log(`Estrazione testo dalla pagina ${i} di ${pdf.numPages}`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    fullText += strings.join(" ") + "\n";
  }
  console.log("Testo estratto dal PDF.");
  return fullText;
}

// Endpoint /api/process
app.post('/api/process', async (req, res) => {
  console.log("Ricevuta richiesta POST a /api/process");
  try {
    // Estrai i dati dal payload
    const {
      nome_azienda,
      //anno_costituzione,
      piva,
      //controlla_altre_imprese,
      //controllata_da_altre_imprese,
      particolarita,
      aspetti_da_migliorare,
      //numero_dipendenti,
      forma_giuridica,
      //fatturato,
      tipologia_azienda,
      dimensioni,
      codice_ateco,
      provincia,
      email
    } = req.body;
    console.log("Dati ricevuti:", req.body);

    // Combina i campi di testo
    //const userText = (particolarita || "") + " " + (aspetti_da_migliorare || "");
    //console.log("Testo utente combinato:", userText);

    // Costruisci l'XML da inviare
    const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>

    
    
<Businesses>
  <Business>
    <PartitaIva>${piva}</PartitaIva>
    <CompanyName>${nome_azienda}</CompanyName>
    <FormaGiuridica>${forma_giuridica}</FormaGiuridica>
    <Tipologia>${tipologia_azienda}</Tipologia>
    <DimensioniAzienda>${dimensioni}</DimensioniAzienda>
    <CodiceIstatAteco>${codice_ateco}</CodiceIstatAteco>
    <Provincia>${provincia}</Provincia>
    <Particolarita>${particolarita}</Particolarita>
    <Email>${email}</Email>
  </Business>
</Businesses>`;
    console.log("XML costruito:", xmlPayload);
    
    // Invia l'XML all'endpoint esterno
    console.log("Invio XML a xmlautomation-rt2n...");
    const uploadResponse = await fetch("https://xmlautomation-rt2n.onrender.com/upload-xml", {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xmlPayload
    });
    if (!uploadResponse.ok) {
      throw new Error("Errore uploading XML: " + uploadResponse.statusText);
    }
    console.log("XML inviato con successo.");

    // Attendi 30 secondi per la generazione della risposta
    console.log("Attesa di 30 secondi per la risposta XML...");
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Recupera l'XML di risposta
    console.log("Recupero XML di risposta da geniabusiness.com...");
    const responseXML = await fetch("https://www.geniabusiness.com/ingplan/xmlbandiazienda.asp");
    if (!responseXML.ok) {
      throw new Error("Errore fetching XML response: " + responseXML.statusText);
    }
    const xmlString = await responseXML.text();
    console.log("XML di risposta ricevuto:", xmlString.substring(0, 100) + "...");
    // 🔹 Controllo: Se l'XML è vuoto, interrompi l'esecuzione
    if (!xmlString || xmlString.trim() === "") {
      console.warn("⚠️ Nessuna risposta XML ricevuta. Terminazione dell'esecuzione.");
      return res.status(200).json({ error: "Nessuna risposta XML ricevuta." });
    }
    // Parsing dell'XML
    console.log("Parsing dell'XML di risposta...");
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "application/xml");
    if (!xmlDoc || xmlDoc.getElementsByTagName("parsererror").length > 0) {
      console.error("⚠️ Errore nel parsing dell'XML.");
      return res.status(200).json({ error: "Errore nel parsing dell'XML." });
    }
    console.log("XML completo ricevuto:\n", xmlString); // Stampa l'intero XML ricevuto

    const bandiNodes = xmlDoc.getElementsByTagName("child");
    // 🔹 Controllo: Se non ci sono bandi, interrompi l'esecuzione
    if (bandiNodes.length === 0) {
      console.warn("⚠️ Nessun bando trovato nell'XML di risposta. Terminazione dell'esecuzione.");
      return res.status(200).json({ message: "Nessun bando disponibile per questa azienda." });
    }
    console.log("Numero di bandi trovati:", bandiNodes.length);

    // Logga l'intero contenuto di ogni nodo per capire la struttura
    for (let i = 0; i < bandiNodes.length; i++) {
      console.log(`Bando ${i} struttura completa:\n`, bandiNodes[i].textContent);
    }

    // Processa ogni bando
    const bandiInfo = [];
    const l = bandiNodes.length
    for (let i = 0; i < bandiNodes.length; i++) {
      const node = bandiNodes[i];
      const nomebando = (node.getElementsByTagName("nomebando")[0]?.textContent) || "N/A";
      const schedasintetica = (node.getElementsByTagName("schedasintetica")[0]?.textContent) || "";
      console.log(`Bando ${i}: nome = ${nomebando}, schedasintetica = ${schedasintetica.substring(0, 50)}...`);
      
      let pdfText = "";
      if (schedasintetica && schedasintetica.endsWith(".pdf")) {
        console.log(`Estrazione PDF per il bando ${i}...`);
        const pdfProxyUrl = "https://xmlautomation-rt2n.onrender.com/pdf-proxy?url=" + encodeURIComponent(schedasintetica);
        pdfText = await extractPdfText(pdfProxyUrl);
      }
      
      let pdfEmbedding = [];
      if (pdfText) {
        try {
          console.log(`Calcolo embedding per il testo estratto dal PDF del bando ${i}...`);
          const truncatedText = pdfText.slice(0, 2000);
          pdfEmbedding = await getEmbedding(truncatedText);
        } catch (err) {
          console.warn("Errore embedding PDF per il bando " + i, err);
        }
      }
      
      // Ottieni l'embedding del testo utente
      console.log(`Calcolo embedding per il testo utente per il bando ${i}...`);
      const userEmbedding = await getEmbedding(aspetti_da_migliorare);
      
      let score = 0;
      if (userEmbedding && pdfEmbedding.length > 0) {
        score = cosineSimilarity(userEmbedding, pdfEmbedding);
      }
      console.log(`Bando ${i} - Similarità calcolata: ${score}`);
      
      bandiInfo.push({ nomebando, schedasintetica});
    }

    // Ordina e seleziona i primi 3 bandi
    //bandiInfo.sort((a, b) => b.score - a.score);
    const top3 = bandiInfo.slice(0, 3);
    console.log("Top 3 bandi:", top3);

    const payloadObject = {
      response: `numeroBandiTotali: ${l} email=${email} bandi=${top3.map(b => `Nome: ${b.nomebando}, Link: ${b.schedasintetica}`).join(" | ")}`
    };
        
    console.log("Dati inviati come stringa:", payloadObject);
    
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadObject)
    });
    
    
    console.log("Risultati inviati al webhook con successo.");
    
    // Risposta finale al client (GoHighLevel)
    res.status(200).json({ message: "Webhook inviato con successo." });
  } catch (err) {
    console.error("Errore nel processing:", err);
    res.status(500).json({ error: err.message });
  }
});

// Avvia il server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
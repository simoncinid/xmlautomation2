const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { DOMParser } = require('@xmldom/xmldom');
const pdfjsLib = require('pdfjs-dist');

const app = express();
app.use(express.json());
app.use(cors());
app.options('*', cors());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Funzione per estrarre il testo da un PDF
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
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    fullText += strings.join(" ") + "\n";
  }
  console.log("Testo estratto dal PDF.");
  return fullText;
}

// Funzione per ottenere il punteggio di rilevanza da OpenAI
async function getRelevanceScore(p, adm, bandoText) {
  console.log("Richiesta punteggio di rilevanza a OpenAI...");

  // Tronca il testo se supera una lunghezza ragionevole (ad esempio 1000 caratteri)
  const maxTextLength = 4000;
  //const truncatedUserText = userText.length > maxTextLength ? userText.substring(0, maxTextLength) + "..." : userText;
  const truncatedBandoText = bandoText.length > maxTextLength ? bandoText.substring(0, maxTextLength) + "..." : bandoText;

  //console.log(`Testo azienda (troncato): ${truncatedUserText.length} caratteri`);
  console.log(`Testo bando (troncato): ${truncatedBandoText.length} caratteri`);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4-turbo",
      messages: [
        { role: "system", content: "Sei un assistente esperto nella valutazione di bandi di finanziamento. Il tuo compito è dare un punteggio di rilevanza tra 0 e 100 basato su quanto il bando è adatto alle esigenze dell'azienda." },
        { role: "user", content: `Ecco la particolarità dell'azienda:\n"${p}"\n\nEcco cosa vuole migliorare l'azienda: ${adm}\n\nEcco il testo del bando:\n"${truncatedBandoText}"\n\nAssegna un punteggio da 0 a 100 indicando quanto questo bando è adatto all'azienda. RISPONDI SOLO CON IL VALORE: SOLO IL NUMERO!!` }
      ],
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errorResponse = await response.json();
    console.error("Errore OpenAI:", errorResponse);
    throw new Error(`Errore OpenAI: ${errorResponse.error.message || response.statusText}`);
  }

  const data = await response.json();
  const gptResponse = data.choices[0].message.content.trim();
  
  const score = parseFloat(gptResponse.match(/\d+/)?.[0] || "0");

  console.log(`Punteggio di rilevanza ricevuto: ${score} - Motivazione: ${gptResponse}`);
  return { score};
}


// Endpoint /api/process
app.post('/api/process', async (req, res) => {
  console.log("Ricevuta richiesta POST a /api/process");
  try {
    const {
      nome_azienda, piva, particolarita, aspetti_da_migliorare,
      forma_giuridica, tipologia_azienda, dimensioni,
      codice_ateco, provincia, email
    } = req.body;
    console.log("Dati ricevuti:", req.body);

    // Costruzione XML
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
    
    console.log("Invio XML a xmlautomation-rt2n...");
    await fetch("https://xmlautomation-rt2n.onrender.com/upload-xml", {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xmlPayload
    });

    console.log("Attesa di 30 secondi per la risposta XML...");
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log("Recupero XML di risposta...");
    try{
      const responseXML = await fetch("https://www.geniabusiness.com/ingplan/xmlbandiazienda.asp");
      const xmlString = await responseXML.text();
      if (!xmlString.trim()) {
        return res.status(200).json({ error: "Nessuna risposta XML ricevuta." });
      }
    }
    catch{
      console.log("errore fecth")
    }

    // Parsing XML
    console.log("Parsing dell'XML di risposta...");
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "application/xml");
    const bandiNodes = xmlDoc.getElementsByTagName("child");

    if (bandiNodes.length === 0) {
      return res.status(200).json({ message: "Nessun bando disponibile per questa azienda." });
    }

    // Processa ogni bando
    const bandiInfo = [];
    for (let i = 0; i < bandiNodes.length; i++) {
      const node = bandiNodes[i];
      const nomebando = node.getElementsByTagName("nomebando")[0]?.textContent || "N/A";
      const schedasintetica = node.getElementsByTagName("schedasintetica")[0]?.textContent || "";
      console.log(`Bando ${i}: nome = ${nomebando}, schedasintetica = ${schedasintetica}`);
    
      let pdfText = "";
      if (schedasintetica.endsWith(".pdf")) {
        console.log(`Estrazione PDF per il bando ${i}...`);
        const pdfProxyUrl = "https://xmlautomation-rt2n.onrender.com/pdf-proxy?url=" + encodeURIComponent(schedasintetica);
        pdfText = await extractPdfText(pdfProxyUrl);
      }
    
      try {
        // Richiedi punteggio a GPT
        let { score, motivation } = await getRelevanceScore(particolarita, aspetti_da_migliorare, pdfText || nomebando);
    
        bandiInfo.push({ nomebando, schedasintetica, score, motivation });
    
      } catch (error) {
        console.error(`❌ Errore OpenAI nel bando ${i}:`, error.message);
        
        // Termina completamente l'esecuzione con un errore
        throw new Error(`Interruzione: OpenAI ha restituito un errore: ${error.message}`);
      }
    }
    

    // Ordina per punteggio e seleziona i migliori 3
    bandiInfo.sort((a, b) => b.score - a.score);
    const top3 = bandiInfo.slice(0, 3);
    console.log("Top 3 bandi:", top3);

    // Invia i risultati al webhook
    const payloadObject = {
      response: `numeroBandiTotali: ${bandiNodes.length} email=${email} bandi=${top3.map(b => `Nome: ${b.nomebando}, Link: ${b.schedasintetica}, Score: ${b.score}`).join(" | ")}`
    };
    
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadObject)
    });

    console.log("Risultati inviati al webhook con successo.");
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

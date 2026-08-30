// OrtoAI — backend
//
// Responsabilidades:
//  1. Buscar evidência científica atual no PubMed para cada material solicitado.
//  2. Sintetizar, via Gemini, uma justificativa curta com nível de evidência.
//  3. Checar/registrar quando um código costuma cair em "pacote" de um hospital específico.
//  4. Ler o laudo de RM por foto (Gemini Vision), comparar com o diagnóstico digitado e
//     apontar incoerências.
//  5. Registrar negativas de convênio por foto (Gemini Vision extrai o motivo alegado) e
//     usar esse histórico para a IA tentar evitar o mesmo motivo em pedidos futuros.
//  6. Manter um cadastro simples de pacientes com histórico de pedidos e laudos.
//  7. Aprender com o tempo: respostas confirmadas viram exemplos de referência (few-shot);
//     acima de um limiar de confiança, a IA responde sem nova busca (mesmo padrão da Audit AI).
//
// Armazenamento: hoje em arquivo JSON local (store.json) só para o app funcionar sem Firebase.
// Quando o projeto Firebase do OrtoAI existir, trocar `store.js` por um adaptador Firestore
// mantendo a mesma interface.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const store = require("./store");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // fotos em base64 (laudo/negativa) precisam de limite maior

const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const GEMINI_MODEL = "gemini-1.5-flash";
const CONFIDENCE_AUTONOMOUS = 0.9; // limiar para responder sem nova busca (igual Audit AI)

// ---------- PubMed ----------
async function buscarPubmed(termo) {
  const filtroEvidencia =
    '(systematic review[pt] OR meta-analysis[pt] OR randomized controlled trial[pt])';
  const query = `${termo} AND knee AND ${filtroEvidencia}`;
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    retmax: "5",
    sort: "relevance",
    term: query,
  });
  if (process.env.PUBMED_API_KEY) params.set("api_key", process.env.PUBMED_API_KEY);

  const searchResp = await fetch(`${PUBMED_BASE}/esearch.fcgi?${params}`);
  const searchData = await searchResp.json();
  const ids = searchData?.esearchresult?.idlist || [];
  if (!ids.length) return [];

  const summaryParams = new URLSearchParams({ db: "pubmed", retmode: "json", id: ids.join(",") });
  const summaryResp = await fetch(`${PUBMED_BASE}/esummary.fcgi?${summaryParams}`);
  const summaryData = await summaryResp.json();

  return ids.map((id) => {
    const doc = summaryData.result?.[id];
    return doc
      ? { pmid: id, titulo: doc.title, ano: (doc.pubdate || "").slice(0, 4), fonte: doc.fulljournalname }
      : { pmid: id };
  });
}

function nivelEvidenciaPorTipo(estudos) {
  if (!estudos.length) return "V";
  return "II"; // filtro do esearch já restringe a RCT/revisão/meta-análise -> nível alto
}

// ---------- Chamada genérica ao Gemini (texto ou texto+imagem) ----------
async function chamarGemini({ prompt, imagemBase64, mimeType = "image/jpeg" }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null; // quem chama decide o fallback

  const parts = [{ text: prompt }];
  if (imagemBase64) parts.push({ inline_data: { mime_type: mimeType, data: imagemBase64 } });

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  const data = await resp.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!texto) {
    console.error("Gemini não retornou texto. Resposta da API:", JSON.stringify(data));
    return null;
  }
  return texto;
}

// ---------- Síntese do parecer (texto) ----------
async function sintetizarComGemini({ diagnostico, material, estudos, exemplos, negativas }) {
  const contextoAprendizado = exemplos.length
    ? `Exemplos de pareceres já validados por este médico, siga o mesmo estilo e rigor:\n${exemplos
        .map((e) => `- ${e.entrada} => ${e.saida}`)
        .join("\n")}`
    : "";

  const contextoNegativas = negativas.length
    ? `Este convênio/hospital já negou este material antes pelos seguintes motivos — escreva o parecer
de forma que antecipe e neutralize esses argumentos, sem citá-los literalmente:\n${negativas
        .map((n) => `- ${n.motivo}`)
        .join("\n")}`
    : "";

  const prompt = `Você é um especialista em cirurgia de joelho auxiliando um cirurgião a justificar
material cirúrgico perante auditoria de convênio.

Diagnóstico: ${diagnostico}
Material solicitado: ${material}
Estudos científicos encontrados (PubMed, alto nível de evidência):
${estudos.map((e) => `- ${e.titulo} (${e.ano}, ${e.fonte})`).join("\n") || "nenhum encontrado"}

${contextoAprendizado}
${contextoNegativas}

Escreva um parecer curto (máximo 4 frases), em português, objetivo e técnico, que:
- afirme a necessidade clínica do material informado, exatamente como foi especificado, com base no diagnóstico,
- cite o nível de evidência dos estudos encontrados,
- use linguagem adequada para anexar a uma solicitação hospitalar.
Não invente estudo que não foi listado. NUNCA sugira um material alternativo, genérico ou de outra marca —
o material informado é fixo (parceria comercial do cirurgião) e sua única função é comprovar cientificamente
a necessidade dele, não questioná-lo ou substituí-lo.`;

  const texto = await chamarGemini({ prompt });
  if (texto) return texto;
  return `[Configure GEMINI_API_KEY] Estudos encontrados para "${material}": ${estudos
    .map((e) => e.titulo)
    .join("; ")}`;
}

// ---------- Rota principal: gerar parecer ----------
app.post("/api/parecer", async (req, res) => {
  try {
    const { paciente, diagnostico, hospital, convenio, codigos = [], materiais = [] } = req.body;
    if (!diagnostico || !materiais.length) {
      return res.status(400).json({ erro: "Informe diagnóstico e ao menos um material." });
    }

    let alertaPacote = null;
    if (hospital && codigos.length) {
      for (const c of codigos) {
        const registro = await store.getPacote(hospital, c.codigo);
        if (registro) {
          alertaPacote = `O código ${c.codigo} (${c.descricao}) costuma cair em pacote no ${hospital}. Considere agrupar ou ajustar antes de enviar.`;
          break;
        }
      }
    }

    const itens = [];
    for (const m of materiais) {
      const exemplos = await store.getExemplos(m.descricao);
      const negativas = convenio ? await store.getNegativas(convenio, m.descricao) : [];
      const exemploAutonomo = exemplos.find((e) => e.confianca >= CONFIDENCE_AUTONOMOUS);

      let resumo, nivelEvidencia, estudos;
      if (exemploAutonomo && !negativas.length) {
        // Só responde sem nova busca se não houver negativa nova a considerar
        resumo = exemploAutonomo.saida;
        nivelEvidencia = exemploAutonomo.nivelEvidencia || "II";
        estudos = [];
      } else {
        estudos = await buscarPubmed(m.descricao);
        nivelEvidencia = nivelEvidenciaPorTipo(estudos);
        resumo = await sintetizarComGemini({ diagnostico, material: m.descricao, estudos, exemplos, negativas });
      }

      itens.push({
        material: m.descricao,
        nivelEvidencia,
        badge: nivelEvidencia <= "II" ? "high" : "ok",
        resumo,
        estudos,
        alertaNegativaAnterior: negativas.length
          ? `Já houve negativa para este material neste hospital — parecer ajustado para tentar evitar repetição.`
          : null,
      });
    }

    const textoPedido = itens.map((i) => i.resumo).join(" ");

    if (paciente) {
      await store.salvarPedidoPaciente(paciente, { diagnostico, hospital, convenio, codigos, materiais, textoPedido });
    }

    res.json({ alertaPacote, itens, textoPedido });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao gerar parecer." });
  }
});

// ---------- Leitura do laudo de RM por foto ----------
app.post("/api/laudo", async (req, res) => {
  try {
    const { paciente, imagemBase64, mimeType, diagnosticoDigitado } = req.body;
    if (!imagemBase64) return res.status(400).json({ erro: "Envie a foto do laudo." });

    const prompt = `Você recebeu a foto de um laudo de ressonância magnética (RM) de joelho.
1. Identifique o nome do paciente, se estiver escrito no laudo. Se não encontrar, escreva "não identificado".
2. Escreva um diagnóstico clínico curto (uma frase, linguagem médica objetiva) baseado nos achados
   principais do laudo — isto será usado para preencher o campo de diagnóstico do médico.
3. Transcreva os achados relevantes do laudo de forma resumida (máximo 6 linhas).
4. O médico digitou este diagnóstico: "${diagnosticoDigitado || "(não informado)"}".
   Aponte, em uma lista curta, qualquer incoerência entre o laudo e o diagnóstico digitado
   (ex.: estrutura citada no diagnóstico que o laudo não confirma, lateralidade divergente,
   achado importante do laudo que não foi mencionado no diagnóstico).
   Se o médico não digitou nada ou não houver incoerência, responda apenas "Nenhuma incoerência encontrada."

Responda em português, em quatro seções com os títulos exatos, cada uma em sua própria linha:
PACIENTE:
DIAGNOSTICO_SUGERIDO:
LAUDO:
INCOERÊNCIAS:`;

    const texto = await chamarGemini({ prompt, imagemBase64, mimeType });
    if (!texto) {
      return res.status(200).json({
        demo: true,
        nomePaciente: null,
        diagnosticoSugerido: null,
        textoExtraido: "[Configure GEMINI_API_KEY para ativar a leitura real do laudo]",
        incoerencias: [],
      });
    }

    const match =
      texto.match(/PACIENTE:([\s\S]*?)DIAGNOSTICO_SUGERIDO:([\s\S]*?)LAUDO:([\s\S]*?)INCOERÊNCIAS:([\s\S]*)/i) || [];
    const [, pacienteBruto = "", diagnosticoBruto = "", laudoBruto = texto, incoerenciasBruto = ""] = match;

    const incoerencias = incoerenciasBruto
      .split("\n")
      .map((l) => l.replace(/^[-•\d.\s]+/, "").trim())
      .filter((l) => l && !/nenhuma incoerência/i.test(l));

    const nomePaciente = pacienteBruto.trim() || null;
    const diagnosticoSugerido = diagnosticoBruto.trim() || null;

    if (paciente) {
      await store.salvarLaudoPaciente(paciente, { textoExtraido: laudoBruto.trim(), diagnosticoDigitado });
    }

    res.json({ nomePaciente, diagnosticoSugerido, textoExtraido: laudoBruto.trim(), incoerencias });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao ler o laudo." });
  }
});

// ---------- Registrar negativa de convênio por foto ----------
app.post("/api/negativa", async (req, res) => {
  try {
    const { hospital, convenio, codigo, material, imagemBase64, mimeType } = req.body;
    if (!convenio || !material || !imagemBase64) {
      return res.status(400).json({ erro: "Informe convênio, material e a foto da negativa." });
    }

    const prompt = `Você recebeu a foto de uma carta/laudo de negativa (glosa) de convênio de saúde
referente a uma solicitação cirúrgica. Extraia, em até 3 frases e em português, o motivo alegado
pelo convênio para a negativa. Seja literal ao motivo, sem interpretar além do que está escrito.`;

    const motivo = await chamarGemini({ prompt, imagemBase64, mimeType });
    const motivoFinal = motivo || "[Configure GEMINI_API_KEY para extrair o motivo automaticamente]";

    await store.salvarNegativa({ hospital, convenio, codigo, material, motivo: motivoFinal });

    res.json({ motivoExtraido: motivoFinal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao registrar a negativa." });
  }
});

// ---------- Pacientes ----------
app.get("/api/pacientes", async (_req, res) => {
  res.json(await store.listarPacientes());
});

app.get("/api/pacientes/:nome", async (req, res) => {
  const paciente = await store.getPaciente(req.params.nome);
  if (!paciente) return res.status(404).json({ erro: "Paciente não encontrado." });
  res.json(paciente);
});

// ---------- Aprendizado: confirmar/corrigir um parecer ----------
app.post("/api/confirmar", async (req, res) => {
  const { material, entrada, saida, nivelEvidencia, correto } = req.body;
  await store.salvarExemplo({ material, entrada, saida, nivelEvidencia, correto });
  res.json({ ok: true });
});

// ---------- Registrar que um código caiu em pacote de um hospital ----------
app.post("/api/pacote", async (req, res) => {
  const { hospital, codigo, descricao } = req.body;
  await store.salvarPacote(hospital, codigo, descricao);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OrtoAI backend rodando na porta ${PORT}`));

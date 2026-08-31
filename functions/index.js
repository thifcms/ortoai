// OrtoAI — Cloud Function (Firebase, 2ª geração)
//
// Mesma lógica de server/server.js (versão local), agora rodando como função
// hospedada no Firebase, com Firestore no lugar do arquivo JSON local.
// Em produção, o Admin SDK se autentica sozinho (sem precisar de chave de serviço).

const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const store = require("./store");

admin.initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10, timeoutSeconds: 300, memory: "512MiB" });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const GEMINI_MODEL = "gemini-flash-latest"; // alias sempre atualizado — evita quebrar quando um modelo específico é descontinuado
const CONFIDENCE_AUTONOMOUS = 0.9;

// ---------- PubMed ----------
async function consultarPubmed(query) {
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

// Busca em estágios, do nível de evidência mais forte para o mais fraco — só desce de nível
// se o estágio anterior não encontrar nada. Nunca aceita nível IV/V sem antes tentar I-III.
async function buscarPubmed(termo) {
  const estagios = [
    {
      nivel: "I",
      filtro: "(systematic review[pt] OR meta-analysis[pt])",
      restringirJoelho: true,
    },
    {
      nivel: "II",
      filtro: "(randomized controlled trial[pt])",
      restringirJoelho: true,
    },
    {
      nivel: "III",
      filtro: '(comparative study[pt] OR "cohort studies"[mh] OR "case-control studies"[mh])',
      restringirJoelho: true,
    },
    {
      // mesmos filtros de evidência forte, mas sem restringir a "knee" — o termo do material
      // já pode ser específico o bastante, e restringir demais pode zerar a busca à toa
      nivel: "I-III (busca ampliada)",
      filtro:
        '(systematic review[pt] OR meta-analysis[pt] OR randomized controlled trial[pt] OR comparative study[pt])',
      restringirJoelho: false,
    },
  ];

  for (const estagio of estagios) {
    const query = estagio.restringirJoelho
      ? `${termo} AND knee AND ${estagio.filtro}`
      : `${termo} AND ${estagio.filtro}`;
    const estudos = await consultarPubmed(query);
    if (estudos.length) {
      const nivel = estagio.nivel.startsWith("I-III") ? "II" : estagio.nivel; // busca ampliada assume nível II por padrão
      return { estudos, nivelEvidencia: nivel };
    }
  }

  return { estudos: [], nivelEvidencia: "V" };
}

// ---------- Gemini ----------
async function chamarGemini({ prompt, imagemBase64, mimeType = "image/jpeg" }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { texto: null, detalhe: "GEMINI_API_KEY ausente em tempo de execução (revisão: " + (process.env.K_REVISION || "desconhecida") + ")" };
  }

  const parts = [{ text: prompt }];
  if (imagemBase64) parts.push({ inline_data: { mime_type: mimeType, data: imagemBase64 } });

  const tentativas = [0, 1000, 2000]; // sem espera, depois 1s, depois 2s
  let ultimoErro = null;

  for (const espera of tentativas) {
    if (espera) await new Promise((r) => setTimeout(r, espera));
    try {
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
      if (texto) return { texto, detalhe: null };

      ultimoErro = `HTTP ${resp.status} — ${JSON.stringify(data).slice(0, 300)}`;
      // Só vale a pena tentar de novo se for sobrecarga temporária (503) ou limite de taxa (429)
      if (resp.status !== 503 && resp.status !== 429) break;
      console.warn(`Gemini sobrecarregado (${resp.status}), tentando de novo...`);
    } catch (err) {
      ultimoErro = `Erro de rede: ${err.message}`;
    }
  }

  console.error("Gemini falhou após tentativas:", ultimoErro);
  return { texto: null, detalhe: ultimoErro };
}

async function sintetizarComGemini({ diagnostico, material, estudos, exemplos, negativas }) {
  const contextoAprendizado = exemplos.length
    ? `Exemplos de pareceres já validados por este médico, siga o mesmo estilo e rigor:\n${exemplos
        .map((e) => `- ${e.entrada} => ${e.saida}`)
        .join("\n")}`
    : "";

  const contextoNegativas = negativas.length
    ? `Este convênio já negou este material antes pelos seguintes motivos — escreva o parecer
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

  const { texto, detalhe } = await chamarGemini({ prompt });
  if (texto) return texto;
  return `[DEMONSTRAÇÃO — ${detalhe}] Estudos encontrados para "${material}": ${estudos
    .map((e) => e.titulo)
    .join("; ")}`;
}

// Texto final da solicitação: consolida diagnóstico + códigos + evidência de todos os materiais
// num único texto corrido, e sugere ajuste de código automaticamente (sem o médico precisar pedir).
async function gerarSolicitacaoConsolidada({ diagnostico, codigos, itens }) {
  const listaCodigos = codigos.length
    ? codigos.map((c) => `- ${c.codigo || "(sem código)"}: ${c.descricao}`).join("\n")
    : "(nenhum código informado)";

  const listaMateriais = itens
    .map((i) => `- ${i.material} (nível de evidência ${i.nivelEvidencia}): ${i.resumo}`)
    .join("\n");

  const prompt = `Você é um especialista em cirurgia de joelho auxiliando um cirurgião a montar uma
solicitação cirúrgica completa para envio ao convênio, com foco em reduzir o risco de glosa e usar os
códigos TUSS mais adequados à complexidade real do caso (nunca fraudulentos — apenas mais precisos).

Diagnóstico do paciente: ${diagnostico}

Códigos TUSS propostos pelo cirurgião:
${listaCodigos}

Materiais solicitados, com evidência científica já levantada para cada um:
${listaMateriais}

Tarefas:
1. Avalie se os códigos TUSS propostos capturam adequadamente a complexidade dos procedimentos
   implícitos no diagnóstico. Se outro código (ou código adicional) tende a ser mais adequado ou a
   resultar em melhor reembolso para esse tipo de caso, sugira — sempre como sugestão para o médico
   avaliar, nunca afirmando que a mudança já foi aplicada. Se os códigos já parecerem adequados, diga
   isso claramente. Seja específico mas breve (2-4 frases).
2. Escreva um texto único e corrido (não uma lista por material), em português, pronto para anexar à
   solicitação do hospital. Esse texto deve:
   - Abrir descrevendo a condição clínica do paciente com base no diagnóstico — a patologia, não o material.
   - Explicar por que o procedimento é necessário para essa condição.
   - Justificar cientificamente cada material solicitado, integrado ao raciocínio clínico do caso
     (não uma lista solta de materiais) — cite o nível de evidência já levantado para cada um.
   - Ter tom técnico-médico, adequado para leitura por auditor de convênio.
   NUNCA sugira substituir os materiais informados — eles são fixos (parceria comercial do cirurgião).

Responda em português, em duas seções com os títulos exatos, cada uma começando em sua própria linha:
CODIGOS_SUGERIDOS:
TEXTO_SOLICITACAO:`;

  const { texto: resposta, detalhe } = await chamarGemini({ prompt });
  if (!resposta) {
    return {
      sugestaoCodigos: null,
      textoPedido: `[DEMONSTRAÇÃO — ${detalhe}] ${itens.map((i) => i.resumo).join(" ")}`,
    };
  }

  const match = resposta.match(/CODIGOS_SUGERIDOS:([\s\S]*?)TEXTO_SOLICITACAO:([\s\S]*)/i);
  if (!match) return { sugestaoCodigos: null, textoPedido: resposta };

  return { sugestaoCodigos: match[1].trim(), textoPedido: match[2].trim() };
}

// ---------- Rota principal: gerar parecer ----------
app.post("/parecer", async (req, res) => {
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

    const processarMaterial = async (m) => {
      const exemplos = await store.getExemplos(m.descricao);
      const negativas = convenio ? await store.getNegativas(convenio, m.descricao) : [];
      const exemploAutonomo = exemplos.find((e) => e.confianca >= CONFIDENCE_AUTONOMOUS);

      let resumo, nivelEvidencia, estudos;
      if (exemploAutonomo && !negativas.length) {
        resumo = exemploAutonomo.saida;
        nivelEvidencia = exemploAutonomo.nivelEvidencia || "II";
        estudos = [];
      } else {
        const resultado = await buscarPubmed(m.descricao);
        estudos = resultado.estudos;
        nivelEvidencia = resultado.nivelEvidencia;
        resumo = await sintetizarComGemini({ diagnostico, material: m.descricao, estudos, exemplos, negativas });
      }

      return {
        material: m.descricao,
        nivelEvidencia,
        badge: nivelEvidencia <= "II" ? "high" : "ok",
        resumo,
        estudos,
        alertaNegativaAnterior: negativas.length
          ? `Já houve negativa para este material com este convênio — parecer ajustado para tentar evitar repetição.`
          : null,
      };
    };

    const itens = await Promise.all(materiais.map(processarMaterial));

    const textoConsolidado = await gerarSolicitacaoConsolidada({ diagnostico, codigos, itens });

    if (paciente) {
      await store.salvarPedidoPaciente(paciente, {
        diagnostico,
        hospital,
        convenio,
        codigos,
        materiais,
        textoPedido: textoConsolidado.textoPedido,
      });
    }

    res.json({
      alertaPacote,
      itens,
      sugestaoCodigos: textoConsolidado.sugestaoCodigos,
      textoPedido: textoConsolidado.textoPedido,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao gerar parecer." });
  }
});

// ---------- Leitura do laudo de RM por foto ----------
app.post("/laudo", async (req, res) => {
  console.log("Rota /laudo chamada. GEMINI_API_KEY presente?", !!process.env.GEMINI_API_KEY);
  try {
    const { paciente, imagemBase64, mimeType, diagnosticoDigitado } = req.body;
    if (!imagemBase64) return res.status(400).json({ erro: "Envie a foto do laudo." });

    const prompt = `Você recebeu a foto de um laudo de ressonância magnética (RM) de joelho.
1. Identifique o nome do paciente, se estiver escrito no laudo. Se não encontrar, escreva "não identificado".
2. Escreva um diagnóstico clínico curto (uma frase, linguagem médica objetiva) baseado nos achados
   principais do laudo — isto será usado para preencher o campo de diagnóstico do médico.
3. Transcreva os achados relevantes do laudo de forma resumida (máximo 6 linhas).
4. O médico digitou este diagnóstico: "${diagnosticoDigitado || "(não informado)"}".
   Aponte, em uma lista curta, qualquer incoerência entre o laudo e o diagnóstico digitado.
   Se o médico não digitou nada ou não houver incoerência, responda apenas "Nenhuma incoerência encontrada."

Responda em português, em quatro seções com os títulos exatos, cada uma em sua própria linha:
PACIENTE:
DIAGNOSTICO_SUGERIDO:
LAUDO:
INCOERÊNCIAS:`;

    const { texto, detalhe } = await chamarGemini({ prompt, imagemBase64, mimeType });
    if (!texto) {
      return res.status(200).json({
        demo: true,
        nomePaciente: null,
        diagnosticoSugerido: null,
        textoExtraido: `[Modo demonstração] ${detalhe}`,
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
app.post("/negativa", async (req, res) => {
  try {
    const { hospital, convenio, codigo, material, imagemBase64, mimeType } = req.body;
    if (!convenio || !material || !imagemBase64) {
      return res.status(400).json({ erro: "Informe convênio, material e a foto da negativa." });
    }

    const prompt = `Você recebeu a foto de uma carta/laudo de negativa (glosa) de convênio de saúde
referente a uma solicitação cirúrgica. Extraia, em até 3 frases e em português, o motivo alegado
pelo convênio para a negativa. Seja literal ao motivo, sem interpretar além do que está escrito.`;

    const { texto: motivo, detalhe } = await chamarGemini({ prompt, imagemBase64, mimeType });
    const motivoFinal = motivo || `[Modo demonstração] ${detalhe}`;

    await store.salvarNegativa({ hospital, convenio, codigo, material, motivo: motivoFinal });

    res.json({ motivoExtraido: motivoFinal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao registrar a negativa." });
  }
});

// ---------- Pacientes ----------
app.get("/pacientes", async (_req, res) => {
  res.json(await store.listarPacientes());
});

app.get("/pacientes/:nome", async (req, res) => {
  const paciente = await store.getPaciente(req.params.nome);
  if (!paciente) return res.status(404).json({ erro: "Paciente não encontrado." });
  res.json(paciente);
});

app.delete("/pacientes/:nome", async (req, res) => {
  await store.excluirPaciente(req.params.nome);
  res.json({ ok: true });
});

// ---------- Aprendizado ----------
app.post("/confirmar", async (req, res) => {
  const { material, entrada, saida, nivelEvidencia, correto } = req.body;
  await store.salvarExemplo({ material, entrada, saida, nivelEvidencia, correto });
  res.json({ ok: true });
});

app.post("/pacote", async (req, res) => {
  const { hospital, codigo, descricao } = req.body;
  await store.salvarPacote(hospital, codigo, descricao);
  res.json({ ok: true });
});

app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    revisao: process.env.K_REVISION || "desconhecida",
    geminiConfigurado: !!process.env.GEMINI_API_KEY,
    pubmedConfigurado: !!process.env.PUBMED_API_KEY,
  })
);

exports.api = onRequest(app);

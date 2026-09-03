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
    retmax: "8",
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

// Busca o resumo (abstract) real de um estudo pelo PMID — dá pra IA achados concretos pra citar,
// não só o título. Só é chamado para os estudos que de fato vão ser citados (poucos por material).
async function buscarResumoEstudo(pmid) {
  try {
    const params = new URLSearchParams({ db: "pubmed", id: pmid, rettype: "abstract", retmode: "xml" });
    if (process.env.PUBMED_API_KEY) params.set("api_key", process.env.PUBMED_API_KEY);

    const resp = await fetch(`${PUBMED_BASE}/efetch.fcgi?${params}`);
    const xml = await resp.text();
    const trechos = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)];
    if (!trechos.length) return null;

    const texto = trechos.map((t) => t[1].replace(/<[^>]+>/g, "").trim()).join(" ");
    return texto.length > 700 ? texto.slice(0, 700) + "…" : texto;
  } catch (err) {
    return null;
  }
}

// Europe PMC: complementa o PubMed — acha estudos que às vezes não aparecem lá (pré-publicações,
// revisões indexadas de outra forma), com o mesmo filtro de qualidade (nível I-III).
async function consultarEuropePmc(termo) {
  try {
    const filtroEvidencia =
      '(PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"Systematic Review" OR PUB_TYPE:"Randomized Controlled Trial" OR PUB_TYPE:"Comparative Study")';
    const query = `${termo} AND knee AND ${filtroEvidencia}`;
    const params = new URLSearchParams({ query, format: "json", pageSize: "8" });

    const resp = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`);
    const data = await resp.json();
    const resultados = data?.resultList?.result || [];

    return resultados.map((r) => ({
      pmid: r.pmid || r.id,
      titulo: r.title,
      ano: r.pubYear,
      fonte: r.journalTitle || "Europe PMC",
    }));
  } catch (err) {
    console.warn("Europe PMC falhou (não crítico, PubMed continua funcionando):", err.message);
    return [];
  }
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

  // Europe PMC roda em paralelo com o PubMed — não atrasa a busca, só adiciona mais estudos ao final.
  const [resultados, estudosEuropePmc] = await Promise.all([
    Promise.all(
      estagios.map(async (estagio) => {
        const query = estagio.restringirJoelho
          ? `${termo} AND knee AND ${estagio.filtro}`
          : `${termo} AND ${estagio.filtro}`;
        const estudos = await consultarPubmed(query);
        const nivel = estagio.nivel.startsWith("I-III") ? "II" : estagio.nivel;
        return { estudos, nivelEvidencia: nivel, ordem: estagios.indexOf(estagio) };
      })
    ),
    consultarEuropePmc(termo),
  ]);

  const melhor = resultados
    .filter((r) => r.estudos.length)
    .sort((a, b) => a.ordem - b.ordem)[0];

  if (!melhor && !estudosEuropePmc.length) return { estudos: [], nivelEvidencia: "V" };

  // Mescla os estudos do PubMed com os do Europe PMC, sem duplicar por PMID
  const estudosBase = melhor ? melhor.estudos : [];
  const pmidsJaIncluidos = new Set(estudosBase.map((e) => String(e.pmid)));
  const estudosComplementares = estudosEuropePmc.filter((e) => !pmidsJaIncluidos.has(String(e.pmid)));

  // Prioriza estudos da Cochrane (padrão-ouro) primeiro, e entre os demais dá preferência a
  // estudos comparativos/de superioridade — citações mais fortes que eficácia isolada vs placebo.
  const termosComparativos = /\bsuperior|versus|\bvs\.?\b|compar(ed|ison|ative)/i;
  const todosEstudos = [...estudosBase, ...estudosComplementares].sort((a, b) => {
    const aCochrane = (a.fonte || "").toLowerCase().includes("cochrane") ? 0 : 1;
    const bCochrane = (b.fonte || "").toLowerCase().includes("cochrane") ? 0 : 1;
    if (aCochrane !== bCochrane) return aCochrane - bCochrane;

    const aComparativo = termosComparativos.test(a.titulo || "") ? 0 : 1;
    const bComparativo = termosComparativos.test(b.titulo || "") ? 0 : 1;
    return aComparativo - bComparativo;
  });

  // Busca o resumo (abstract) real dos 3 principais estudos — dá pra IA achados concretos pra
  // citar (mais de um, com achados diferentes), sem sobrecarregar com resumo de todo mundo.
  const principais = todosEstudos.slice(0, 3);
  const resumos = await Promise.all(principais.map((e) => buscarResumoEstudo(e.pmid)));
  principais.forEach((e, i) => {
    if (resumos[i]) e.resumoAbstract = resumos[i];
  });

  return {
    estudos: todosEstudos,
    nivelEvidencia: melhor ? melhor.nivelEvidencia : "II", // Europe PMC já filtra por nível I-III
  };
}

// ---------- Gemini ----------
// Groq como fallback gratuito quando o Gemini estiver sobrecarregado ou sem cota (mesmo padrão já usado na Audit AI).
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = "qwen/qwen3.6-27b";

async function chamarGroq({ prompt, imagemBase64, mimeType = "image/jpeg" }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { texto: null, detalhe: "GROQ_API_KEY não configurada (fallback indisponível)" };

  const content = imagemBase64
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imagemBase64}` } },
      ]
    : prompt;

  const tentativas = [0, 1000, 2500]; // sem espera, depois 1s, depois 2.5s
  let ultimoErro = null;

  for (const espera of tentativas) {
    if (espera) await new Promise((r) => setTimeout(r, espera));
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: imagemBase64 ? GROQ_VISION_MODEL : GROQ_TEXT_MODEL,
          messages: [{ role: "user", content }],
          // qwen3.6 (visão) desliga o raciocínio de verdade com "none". O gpt-oss (texto) já
          // retorna o raciocínio num campo separado por padrão, então não precisa de ajuste aqui.
          ...(imagemBase64 ? { reasoning_effort: "none" } : {}),
        }),
      });
      const data = await resp.json();
      const texto = data?.choices?.[0]?.message?.content?.trim();
      if (texto) return { texto, detalhe: null };

      ultimoErro = `Groq HTTP ${resp.status} — ${JSON.stringify(data).slice(0, 300)}`;
      if (resp.status !== 503 && resp.status !== 429) break; // só insiste em sobrecarga/limite
      console.warn(`Groq sobrecarregado (${resp.status}), tentando de novo...`);
    } catch (err) {
      ultimoErro = `Erro de rede no Groq: ${err.message}`;
    }
  }

  return { texto: null, detalhe: ultimoErro };
}

// Tenta o Gemini primeiro (com retry em sobrecarga/limite); se esgotar as tentativas ou faltar
// a chave, cai automaticamente para o Groq (gratuito) como fallback — mesmo padrão da Audit AI.
// Traduz a descrição do material (geralmente em português administrativo, tipo "01 kit cânula
// para bloqueio de nervo") para um termo curto de busca científica em inglês — sem isso, o PubMed
// quase nunca acha nada e o material cai em nível V à toa.
async function termoBuscaCientifica(material, contextoCodigos) {
  // Atalho determinístico: se os códigos já mencionam um nervo/estrutura específica bem conhecida,
  // usa o termo científico direto em vez de confiar na IA para inferir isso do contexto — mais
  // confiável, principalmente pra termos que a busca precisa acertar sempre (ex.: genicular).
  const contextoNorm = (contextoCodigos || "").toLowerCase();
  if (contextoNorm.includes("genicular")) return "genicular nerve block knee osteoarthritis";

  const prompt = `Traduza e resuma, em inglês, o material cirúrgico abaixo em um termo curto de busca
científica (3-6 palavras) adequado para pesquisar no PubMed — sem quantidade, sem marca comercial,
focando na função clínica/técnica do material.
${
  contextoCodigos
    ? `Use este contexto do procedimento (códigos solicitados) para tornar o termo mais ESPECÍFICO
quando o material for algo genérico (ex.: um "kit de cânula" usado num bloqueio de nervo específico
deve virar o nome científico desse nervo, não um termo genérico de bloqueio):
${contextoCodigos}`
    : ""
}
Responda apenas com o termo em inglês, nada mais, sem aspas, sem explicação.

Material: ${material}`;

  const { texto } = await chamarIA({ prompt });
  if (!texto) return material; // fallback: busca com o texto original mesmo, melhor que nada
  return texto.trim().replace(/^["']|["']$/g, "").split("\n")[0];
}

async function chamarIA({ prompt, imagemBase64, mimeType = "image/jpeg" }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    const tentativas = [0, 1000, 2000]; // sem espera, depois 1s, depois 2s
    let ultimoErro = null;

    for (const espera of tentativas) {
      if (espera) await new Promise((r) => setTimeout(r, espera));
      try {
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
        if (texto) return { texto, detalhe: null, provedor: "gemini" };

        ultimoErro = `HTTP ${resp.status} — ${JSON.stringify(data).slice(0, 300)}`;
        console.warn(`Gemini falhou (${resp.status}), tentando de novo...`);
      } catch (err) {
        ultimoErro = `Erro de rede: ${err.message}`;
      }
    }
    console.warn("Gemini falhou, caindo para o Groq:", ultimoErro);
  } else {
    console.warn("GEMINI_API_KEY ausente, indo direto para o Groq.");
  }

  const resultadoGroq = await chamarGroq({ prompt, imagemBase64, mimeType });
  if (resultadoGroq.texto) return { texto: resultadoGroq.texto, detalhe: null, provedor: "groq" };

  return { texto: null, detalhe: resultadoGroq.detalhe, provedor: null };
}

async function sintetizarComGemini({ diagnostico, material, estudos, exemplos, negativas, contextoBloqueio }) {
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

  const avisoContexto =
    contextoBloqueio === "dor"
      ? `\nATENÇÃO: este é um pedido de MANEJO DE DOR CRÔNICA de joelho, realizado pelo próprio ortopedista
(NÃO é uma indicação de anestesista, nem cirurgia associada). NUNCA use "perioperatório(a)",
"pós-operatório(a)" ou linguagem de cirurgia — isso seria factualmente errado. Se o material for
bloqueio de nervo periférico, trate-o especificamente como bloqueio dos NERVOS GENICULARES para
dor de osteoartrose de joelho, procedimento intervencionista realizado pelo ortopedista.\n`
      : "";

  const prompt = `Você é um especialista em cirurgia de joelho auxiliando um cirurgião a justificar
material cirúrgico perante auditoria de convênio.
${avisoContexto}
Diagnóstico: ${diagnostico}
Material solicitado: ${material}
Estudos científicos encontrados (PubMed, alto nível de evidência):
${estudos
  .map((e) => `- ${e.titulo} (${e.ano}, ${e.fonte}, PMID: ${e.pmid})${e.resumoAbstract ? `\n  Resumo do estudo: ${e.resumoAbstract}` : ""}`)
  .join("\n") || "nenhum encontrado"}

${contextoAprendizado}
${contextoNegativas}

Escreva um parecer objetivo e técnico, em português (5-8 frases se necessário — não precisa ser curto,
precisa ser robusto e difícil de questionar), que:
- afirme a necessidade clínica do material informado, exatamente como foi especificado, com base no diagnóstico,
- CITE de 2 a 3 estudos da lista acima quando houver disponíveis (cite todos se houver menos),
  no formato "(periódico, ano — PMID: xxxxx)" — nunca apenas mencione "nível de evidência X"
  sem apontar qual estudo sustenta a afirmação. Se algum estudo da lista demonstrar superioridade
  comparativa (ex.: "superior a", "versus", "compared with"), priorize citá-lo — é uma citação mais
  forte que um estudo isolado de eficácia vs placebo,
- Quando o "Resumo do estudo" estiver disponível na lista acima, cite um ACHADO CONCRETO dele (ex.:
  desfecho medido, resultado comparativo) — mas EXTRAIA APENAS o achado sobre o material/técnica
  REALMENTE solicitado. Se o estudo também avaliar ou comparar outro material, técnica ou nervo
  diferente do que está sendo pedido (ex.: bloqueio femoral quando o pedido é genicular; PRP quando
  o pedido é ácido hialurônico), NÃO mencione esse outro procedimento de forma alguma — cite só a
  parte do estudo relevante ao que foi solicitado,
- Evite termos em inglês sempre que houver equivalente em português (ex.: "escala visual analógica
  de dor" em vez de "VAS"); quando o nome do instrumento não tiver tradução consagrada, pode mantê-lo,
- use linguagem adequada para anexar a uma solicitação hospitalar,
- escreva como um PEDIDO MÉDICO INICIAL (o cirurgião solicitando autorização), nunca como uma
  contestação, recurso ou resposta a uma negativa já recebida — não use estrutura de "argumento de
  defesa" nem títulos como "risco de não fornecimento"; integre a consequência clínica de forma
  natural dentro do texto corrido, em tom de justificativa direta, não de rebate.
Não invente estudo, periódico, ano, PMID ou achado que não esteja na lista/resumo acima. Se não houver
estudo na lista, diga isso com honestidade em vez de citar algo inexistente. NUNCA sugira um material
alternativo, genérico ou de outra marca — o material informado é fixo (parceria comercial do cirurgião)
e sua única função é comprovar cientificamente a necessidade dele, não questioná-lo ou substituí-lo.`;

  const { texto, detalhe } = await chamarIA({ prompt });
  if (texto) return texto;
  return `[DEMONSTRAÇÃO — ${detalhe}] Estudos encontrados para "${material}": ${estudos
    .map((e) => e.titulo)
    .join("; ")}`;
}

// Texto final da solicitação: consolida diagnóstico + códigos + evidência de todos os materiais
// num único texto corrido, e sugere ajuste de código automaticamente (sem o médico precisar pedir).
// Texto aprovado pelo médico como referência de tom/estilo (não de conteúdo — ver instrução no prompt).
const EXEMPLO_ESTILO_APROVADO = `Solicito autorização para realização de bloqueio de nervos periféricos (nervos geniculares), código TUSS 31602118, e punção articular diagnóstica/terapêutica com infiltração intra-articular de ácido hialurônico de alta pureza, código TUSS 30713137, para a paciente Vanice Clemente, joelho direito, conforme fundamentação clínica e científica a seguir.

A ressonância magnética do joelho direito evidencia alteração degenerativa difusa dos meniscos, predominante no menisco lateral, com rotura horizontal do corpo e corno posterior associada a extrusão meniscal e perimeniscite; degeneração do menisco medial sem rotura associada; alterações degenerativas avançadas do compartimento femorotibial lateral, com exposição de osso subcondral, esclerose e cistos subcondrais; condropatia patelofemoral incipiente; derrame articular moderado com sinais de sinovite reacional; e entesopatia do aparelho extensor. Esse conjunto de achados caracteriza gonartrose tricompartimental de predomínio femorotibial lateral, quadro compatível com a dor crônica intensa e a limitação funcional relatadas pela paciente, refratárias ao tratamento clínico conservador, justificando a indicação de abordagem intervencionista ambulatorial voltada ao alívio da dor e à melhora funcional.

O bloqueio dos nervos geniculares é procedimento intervencionista realizado pelo próprio ortopedista para controle da dor nociceptiva de origem articular em pacientes com gonartrose. Ensaio clínico randomizado, controlado por placebo, demonstrou alívio significativo da dor no curto prazo com o bloqueio dos nervos geniculares em pacientes com osteoartrose de joelho (Arthritis & Rheumatology, 2023 — PMID: 36369781). Revisão sistemática com meta-análise de ensaios clínicos randomizados mostrou redução estatisticamente significativa da dor e melhora da função articular no primeiro e terceiro mês após o procedimento (Pain Physician, 2022 — PMID: 39143682). Esses dados sustentam a indicação do bloqueio dos nervos geniculares, realizado com o kit de cânula solicitado, para o manejo da dor crônica desta paciente.

A infiltração intra-articular de ácido hialurônico de alta pureza tem respaldo em evidência de nível I para o tratamento da osteoartrose de joelho. Meta-análise de ensaios clínicos randomizados demonstrou melhora dos escores de dor a partir do terceiro mês de acompanhamento, com benefício mantido até o sexto mês após a infiltração (Experimental and Therapeutic Medicine, 2015 — PMID: 25574222). Revisão sistemática de meta-análises sobre o uso do ácido hialurônico intra-articular na osteoartrose de joelho corroborou esse efeito terapêutico sobre a dor e a função articular ao longo do acompanhamento clínico (Scientific Reports, 2016 — PMID: 27616273). Esses achados sustentam a indicação da infiltração de ácido hialurônico de alta pureza para controle da dor e melhora funcional desta paciente.

A não realização desses procedimentos tende a manter a dor crônica intensa e a limitação funcional já relatadas, com possível necessidade de maior uso de analgesia sistêmica e progressão dos sintomas articulares — desfechos evitáveis com a intervenção ora solicitada.`;

async function gerarSolicitacaoConsolidada({ diagnostico, codigos, itens, laudoTexto, contextoBloqueio }) {
  const listaCodigos = codigos.length
    ? codigos.map((c) => `- ${c.codigo || "(sem código)"}: ${c.descricao}`).join("\n")
    : "(nenhum código informado)";

  const listaMateriais = itens
    .map((i) => {
      const estudosFormatados = i.estudos.length
        ? i.estudos
            .map(
              (e) =>
                `    · ${e.titulo} — ${e.fonte || "periódico não informado"}, ${e.ano || "s/ data"} (PMID: ${e.pmid})` +
                (e.resumoAbstract ? `\n      Resumo: ${e.resumoAbstract}` : "")
            )
            .join("\n")
        : "    · Nenhum estudo específico encontrado nesta busca.";
      return `- ${i.material} (nível de evidência ${i.nivelEvidencia})\n  Estudos disponíveis para citação:\n${estudosFormatados}`;
    })
    .join("\n");

  const avisoContexto =
    contextoBloqueio === "dor"
      ? `\nATENÇÃO — CONTEXTO CRÍTICO: este pedido é de MANEJO DE DOR CRÔNICA de joelho, realizado pelo
próprio ortopedista (NÃO é indicação de anestesista, nem há cirurgia associada agora). NUNCA use os
termos "perioperatório(a)", "pós-operatório(a)", "intraoperatório(a)" ou qualquer linguagem que
sugira que há uma cirurgia acontecendo — isso seria factualmente errado e enfraqueceria o pedido
perante o auditor. Descreva como tratamento intervencionista/ambulatorial da dor (ex.: "alívio da
dor crônica", "tratamento conservador da dor", "melhora funcional"). Se o material for bloqueio de
nervo periférico, trate-o especificamente como bloqueio dos NERVOS GENICULARES para dor de
osteoartrose de joelho — não femoral, obturador ou outro nervo de contexto cirúrgico.\n`
      : "";

  const prompt = `Você é um especialista em cirurgia de joelho auxiliando um cirurgião a montar uma
solicitação cirúrgica completa para envio ao convênio, com foco em reduzir o risco de glosa e usar os
códigos TUSS mais adequados à complexidade real do caso (nunca fraudulentos — apenas mais precisos).

MODELO DE REFERÊNCIA — o médico aprovou este texto como exemplo do TOM e ESTILO de escrita que
espera (formalidade, construção de frases, forma de citar estudo, jeito de fechar o parágrafo).
Use como referência de COMO escrever, mas NUNCA reaproveite os dados, diagnóstico, PMIDs ou
achados deste exemplo em outro caso — isso é só um exemplo de estilo, não de conteúdo:

"${EXEMPLO_ESTILO_APROVADO}"

${avisoContexto}
Diagnóstico do paciente: ${diagnostico}
${laudoTexto ? `Achados do laudo de imagem (RM): ${laudoTexto}` : ""}

Códigos TUSS propostos pelo cirurgião:
${listaCodigos}

Materiais solicitados, com os estudos científicos já levantados no PubMed para cada um:
${listaMateriais}

Tarefas:
1. Avalie se os códigos TUSS propostos capturam a complexidade do caso. Se outro código tende a
   ser mais adequado, sugira em 1-2 frases — nunca afirme que já aplicou a mudança. Se já estiverem
   adequados, diga isso em 1 frase.
2. Escreva um texto único e corrido (não lista por material, SEM cabeçalhos em negrito ou títulos
   separando cada material — é um parágrafo corrido, não um documento estruturado em seções), em
   português, técnico e objetivo — sem floreio nem repetição entre materiais, mas SEM limite curto de
   tamanho: pode ser tão longo quanto for necessário para ficar robusto e difícil de questionar (o
   auditor prefere um texto bem fundamentado a um texto curto e vago).

   ESTRUTURA FIXA — siga sempre esta mesma ordem de parágrafos, em todo pedido, independente do
   caso (só o conteúdo muda, a estrutura não):
   Parágrafo 1: frase de abertura formal de solicitação (ver instrução abaixo).
   Parágrafo 2: quadro clínico do paciente com base no diagnóstico/laudo.
   Parágrafo(s) seguinte(s): um parágrafo por material, na mesma ordem em que os materiais foram
   informados, cada um justificando e citando os estudos daquele material específico.
   Parágrafo final: consequência clínica de negar os materiais, integrada ao texto corrido.

   O texto deve:
   - ABRIR com uma frase direta e formal de solicitação, endereçada ao auditor do convênio, nomeando
     objetivamente os procedimentos/materiais e os códigos TUSS envolvidos (ex.: "Solicito autorização
     para realização de [procedimento(s)], código(s) TUSS [X e Y], com uso de [material(is)], conforme
     justificativa clínica e científica a seguir."). Só depois dessa frase de abertura, siga com a
     fundamentação clínica e científica.
   - RESTRIÇÃO CRÍTICA: fale exclusivamente sobre os códigos e materiais LISTADOS ACIMA. NUNCA
     descreva, mencione ou preveja outro procedimento (ex.: artroscopia, meniscectomia, sinovectomia)
     que não esteja explicitamente nos códigos informados — mesmo que o diagnóstico ou o laudo
     sugiram que esse outro procedimento também seria indicado. O médico pediu especificamente o que
     está na lista de códigos; a solicitação é só disso.
   - Descrever a condição clínica do paciente com base no diagnóstico${laudoTexto ? ", correlacionando explicitamente com os achados específicos do laudo de imagem informado acima (cite o achado radiológico exato, não uma menção genérica ao laudo)" : ""},
     e justificar a necessidade EXATA dos procedimentos/materiais listados (não de procedimentos
     hipotéticos adicionais).
   - Para cada material, CITE de 2 a 3 estudos quando houver disponíveis na lista (cite todos se
     houver menos), no formato "(periódico, ano — PMID: xxxxx)". Se algum estudo demonstrar
     superioridade comparativa (ex.: "superior a", "versus", "compared with"), priorize citá-lo.
     Quando a lista trouxer
     "Resumo" do estudo, cite um achado concreto dele (desfecho medido, resultado comparativo) — não
     apenas "há evidência de nível X". Uma citação vaga é fácil de questionar; um achado específico não.
     EXTRAIA APENAS o achado sobre o material/técnica REALMENTE solicitado: se o estudo também avaliar
     ou comparar outro material, técnica ou nervo diferente do que está sendo pedido (ex.: bloqueio
     femoral quando o pedido é genicular; PRP quando o pedido é ácido hialurônico), NÃO mencione esse
     outro procedimento de forma alguma. Se não houver estudo para um material, diga isso com
     honestidade, sem inventar citação.
   - Evite termos em inglês sempre que houver equivalente consagrado em português (ex.: "escala visual
     analógica de dor" em vez de "VAS"); mantenha só o que não tiver tradução usual na prática clínica.
   - Escreva como um PEDIDO MÉDICO INICIAL — o cirurgião solicitando autorização pela primeira vez,
     nunca como contestação, recurso ou resposta a uma negativa já recebida. Não use títulos como
     "risco de não fornecimento" nem estrutura de "argumento de defesa". Integre a consequência clínica
     de negar o material de forma natural dentro do texto corrido, em tom de justificativa direta.
   - Fechar com 1-2 frases sobre o risco clínico de negar o material (ex.: falha de fixação,
     reintervenção), só se a literatura citada sustentar isso — sem exagero, integradas ao texto
     corrido, não como uma seção separada com título próprio.
   NUNCA sugira substituir os materiais informados — eles são fixos (parceria comercial do cirurgião).

Responda em português, em duas seções com os títulos exatos, cada uma começando em sua própria linha:
CODIGOS_SUGERIDOS:
TEXTO_SOLICITACAO:

IMPORTANTE: não mostre seu raciocínio, rascunho ou processo de análise — comece a resposta
diretamente em "CODIGOS_SUGERIDOS:", sem nenhum texto antes.`;

  const { texto: resposta, detalhe } = await chamarIA({ prompt });
  if (!resposta) {
    return {
      sugestaoCodigos: null,
      textoPedido: `[DEMONSTRAÇÃO — ${detalhe}] ${itens.map((i) => i.resumo).join(" ")}`,
    };
  }

  const match = resposta.match(/CODIGOS_SUGERIDOS:([\s\S]*?)TEXTO_SOLICITACAO:([\s\S]*)/i);
  if (!match) {
    console.error("IA não seguiu o formato esperado na consolidação (possível raciocínio vazado):", resposta.slice(0, 500));
    return {
      sugestaoCodigos: null,
      textoPedido: "[Modo demonstração] A IA retornou um formato inesperado (provável raciocínio interno do modelo). Tente gerar o parecer de novo.",
    };
  }

  return { sugestaoCodigos: match[1].trim(), textoPedido: match[2].trim() };
}

// ---------- Rota principal: gerar parecer ----------
app.post("/parecer", async (req, res) => {
  try {
    const { paciente, diagnostico, hospital, convenio, codigos = [], materiais = [], contextoBloqueio } = req.body;
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
        await store.registrarUsoCache();
      } else {
        const contextoCodigos = codigos.map((c) => c.descricao).filter(Boolean).join("; ");
        const termoBusca = await termoBuscaCientifica(m.descricao, contextoCodigos);
        const resultado = await buscarPubmed(termoBusca);
        estudos = resultado.estudos;
        nivelEvidencia = resultado.nivelEvidencia;
        resumo = await sintetizarComGemini({ diagnostico, material: m.descricao, estudos, exemplos, negativas, contextoBloqueio });
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

    let laudoTexto = req.body.laudoTexto || null;
    if (!laudoTexto && paciente) {
      const registro = await store.getPaciente(paciente);
      const laudos = registro?.laudos || [];
      if (laudos.length) laudoTexto = laudos[laudos.length - 1].textoExtraido;
    }

    const textoConsolidado = await gerarSolicitacaoConsolidada({ diagnostico, codigos, itens, laudoTexto, contextoBloqueio });

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
INCOERÊNCIAS:

IMPORTANTE: não mostre seu raciocínio, rascunho ou processo de análise — comece a resposta
diretamente em "PACIENTE:", sem nenhum texto antes.`;

    const { texto, detalhe } = await chamarIA({ prompt, imagemBase64, mimeType });
    if (!texto) {
      return res.status(200).json({
        demo: true,
        nomePaciente: null,
        diagnosticoSugerido: null,
        textoExtraido: `[Modo demonstração] ${detalhe}`,
        incoerencias: [],
      });
    }

    const match = texto.match(
      /PACIENTE:([\s\S]*?)DIAGNOSTICO_SUGERIDO:([\s\S]*?)LAUDO:([\s\S]*?)INCOERÊNCIAS:([\s\S]*)/i
    );

    if (!match) {
      console.error("IA não seguiu o formato esperado (possível raciocínio vazado):", texto.slice(0, 500));
      return res.status(200).json({
        demo: true,
        nomePaciente: null,
        diagnosticoSugerido: null,
        textoExtraido: "[Modo demonstração] A IA retornou um formato inesperado (provável raciocínio interno do modelo em vez da resposta final). Tente de novo — normalmente resolve na segunda tentativa.",
        incoerencias: [],
      });
    }

    const [, pacienteBruto, diagnosticoBruto, laudoBruto, incoerenciasBruto] = match;

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
// ---------- Sugestão de bloqueio de nervo periférico por IA (restrita a opções válidas) ----------
const NERVOS_VALIDOS_JOELHO = [
  "nervo femoral",
  "nervo obturador",
  "nervo safeno (canal dos adutores)",
  "nervo ciático (região poplítea)",
  "nervos geniculares",
];

app.post("/sugerir-bloqueio", async (req, res) => {
  try {
    const { diagnostico, laudoTexto, contexto } = req.body;
    if (!diagnostico) return res.status(400).json({ erro: "Informe o diagnóstico." });

    const ehDorCronica = contexto === "dor";

    // Dor crônica de joelho (sem cirurgia): não deixa a critério da IA — o padrão clínico
    // consolidado é sempre o bloqueio dos nervos geniculares. Decidir isso de forma fixa evita
    // que a IA ocasionalmente ignore a instrução e volte a sugerir um nervo de contexto cirúrgico.
    if (ehDorCronica) {
      return res.json({
        codigos: [{ codigo: "31602118", descricao: "Bloqueio de nervo periférico (nervos geniculares)" }],
        demo: false,
        detalhe: null,
      });
    }

    const prompt = `Você é um ortopedista especialista em joelho decidindo quais nervos periféricos
bloquear como adjuvante analgésico de uma CIRURGIA de joelho (não é manejo de dor crônica isolado),
com base no diagnóstico do paciente. Os nervos mais usados pelo próprio ortopedista nesse contexto
são femoral, obturador e safeno (canal dos adutores) — o ciático entra em procedimentos mais
extensos. NUNCA escolha "nervos geniculares" aqui — esse é usado apenas para dor crônica sem cirurgia.

Diagnóstico: ${diagnostico}
${laudoTexto ? `Achados do laudo de imagem: ${laudoTexto}` : ""}

Escolha SOMENTE entre estas opções (nunca cite outro nervo fora desta lista):
${NERVOS_VALIDOS_JOELHO.filter((n) => n !== "nervos geniculares").map((n) => `- ${n}`).join("\n")}

Selecione de 1 a 3 nervos clinicamente adequados para este caso (não escolha todos por padrão —
só os que fazem sentido).

Responda em português, apenas com a lista escolhida, um nervo por linha, cada linha começando com
"- ", usando exatamente o texto das opções acima. Não escreva mais nada além da lista — sem
explicação, sem raciocínio, sem texto antes ou depois.`;

    const { texto, detalhe } = await chamarIA({ prompt });

    let nervosEscolhidos = [];
    if (texto) {
      nervosEscolhidos = texto
        .split("\n")
        .map((l) => l.replace(/^[-•\s]+/, "").trim().toLowerCase())
        .filter((l) => NERVOS_VALIDOS_JOELHO.some((n) => n.toLowerCase() === l));
    }

    // Se a IA falhou ou não retornou nada válido, cai num padrão seguro
    if (!nervosEscolhidos.length) {
      nervosEscolhidos = ["nervo femoral", "nervo obturador", "nervo safeno (canal dos adutores)"];
    }

    const codigos = nervosEscolhidos.map((nervo) => {
      const nomeOriginal = NERVOS_VALIDOS_JOELHO.find((n) => n.toLowerCase() === nervo) || nervo;
      return { codigo: "31602118", descricao: `Bloqueio de nervo periférico (${nomeOriginal})` };
    });

    res.json({ codigos, demo: !texto, detalhe: texto ? null : detalhe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao sugerir bloqueio." });
  }
});

app.post("/negativa", async (req, res) => {
  try {
    const { hospital, convenio, codigo, material, imagemBase64, mimeType } = req.body;
    if (!convenio || !material || !imagemBase64) {
      return res.status(400).json({ erro: "Informe convênio, material e a foto da negativa." });
    }

    const prompt = `Você recebeu a foto de uma carta/laudo de negativa (glosa) de convênio de saúde
referente a uma solicitação cirúrgica. Extraia, em até 3 frases e em português, o motivo alegado
pelo convênio para a negativa. Seja literal ao motivo, sem interpretar além do que está escrito.
IMPORTANTE: responda apenas com as 3 frases finais — não mostre seu raciocínio ou processo de análise.`;

    const { texto: motivo, detalhe } = await chamarIA({ prompt, imagemBase64, mimeType });
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

// ---------- Materiais cadastrados ----------
app.get("/materiais", async (_req, res) => {
  res.json(await store.listarMateriaisCadastrados());
});

app.post("/materiais", async (req, res) => {
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ erro: "Informe o nome do material." });
  await store.salvarMaterialCadastrado(nome);
  res.json({ ok: true });
});

app.delete("/materiais/:nome", async (req, res) => {
  await store.excluirMaterialCadastrado(req.params.nome);
  res.json({ ok: true });
});

// ---------- Procedimentos cadastrados ----------
app.get("/procedimentos", async (_req, res) => {
  res.json(await store.listarProcedimentos());
});

app.post("/procedimentos", async (req, res) => {
  const { nome, codigos, materiais } = req.body;
  if (!nome) return res.status(400).json({ erro: "Informe o nome do procedimento." });
  await store.salvarProcedimento({ nome, codigos, materiais });
  res.json({ ok: true });
});

app.get("/procedimentos/:nome", async (req, res) => {
  const p = await store.getProcedimento(req.params.nome);
  if (!p) return res.status(404).json({ erro: "Procedimento não encontrado." });
  res.json(p);
});

app.delete("/procedimentos/:nome", async (req, res) => {
  await store.excluirProcedimento(req.params.nome);
  res.json({ ok: true });
});

app.get("/estatisticas", async (_req, res) => {
  const stats = await store.estatisticasAprendizado();
  // Estimativa aproximada de tokens por chamada de IA evitada (prompt + resposta de síntese) —
  // é uma estimativa, não uma contagem exata de tokens.
  const TOKENS_ESTIMADOS_POR_CHAMADA = 1200;
  res.json({
    ...stats,
    tokensEconomizadosEstimados: stats.chamadasEconomizadas * TOKENS_ESTIMADOS_POR_CHAMADA,
  });
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

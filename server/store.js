// Armazenamento provisório em arquivo local.
// Interface pensada para ser trocada por Firestore sem mudar server.js:
// só reimplementar estas funções apontando para as coleções do projeto Firebase do OrtoAI.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "store.json");

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { pacotes: {}, exemplos: {}, pacientes: {}, negativas: {} };
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  data.pacientes = data.pacientes || {};
  data.negativas = data.negativas || {};
  return data;
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------- Pacotes por hospital ----------
async function getPacote(hospital, codigo) {
  const data = load();
  return data.pacotes[`${hospital}::${codigo}`] || null;
}

async function salvarPacote(hospital, codigo, descricao) {
  const data = load();
  const chave = `${hospital}::${codigo}`;
  const atual = data.pacotes[chave] || { descricao, ocorrencias: 0 };
  atual.ocorrencias += 1;
  atual.descricao = descricao;
  atual.ultimaVez = new Date().toISOString();
  data.pacotes[chave] = atual;
  save(data);
  return atual;
}

// ---------- Exemplos aprendidos (few-shot / auto-promote) ----------
async function getExemplos(material) {
  const data = load();
  const chave = material.trim().toLowerCase();
  return data.exemplos[chave] || [];
}

async function salvarExemplo({ material, entrada, saida, nivelEvidencia, correto }) {
  const data = load();
  const chave = material.trim().toLowerCase();
  const lista = data.exemplos[chave] || [];

  const existente = lista.find((e) => e.saida === saida);
  if (existente) {
    existente.confirmacoes += correto ? 1 : -1;
  } else {
    lista.push({ entrada, saida, nivelEvidencia, confirmacoes: correto ? 1 : 0 });
  }

  lista.forEach((e) => (e.confianca = Math.max(0, Math.min(1, e.confirmacoes / 5))));

  data.exemplos[chave] = lista;
  save(data);
}

// ---------- Pacientes ----------
// chave: nome normalizado (trocar por CPF/ID quando o cadastro tiver campo próprio)
function chavePaciente(nome) {
  return nome.trim().toLowerCase();
}

async function getPaciente(nome) {
  const data = load();
  return data.pacientes[chavePaciente(nome)] || null;
}

async function listarPacientes() {
  const data = load();
  return Object.values(data.pacientes).map((p) => ({
    nome: p.nome,
    ultimoPedido: p.pedidos.length ? p.pedidos[p.pedidos.length - 1].data : null,
  }));
}

async function salvarPedidoPaciente(nome, pedido) {
  if (!nome) return;
  const data = load();
  const chave = chavePaciente(nome);
  const atual = data.pacientes[chave] || { nome, criadoEm: new Date().toISOString(), pedidos: [], laudos: [] };
  atual.pedidos.push({ data: new Date().toISOString(), ...pedido });
  data.pacientes[chave] = atual;
  save(data);
}

async function salvarLaudoPaciente(nome, laudo) {
  if (!nome) return;
  const data = load();
  const chave = chavePaciente(nome);
  const atual = data.pacientes[chave] || { nome, criadoEm: new Date().toISOString(), pedidos: [], laudos: [] };
  atual.laudos.push({ data: new Date().toISOString(), ...laudo });
  data.pacientes[chave] = atual;
  save(data);
}

// ---------- Negativas de convênio (aprendizado preventivo) ----------
// chave: quem nega é o convênio, não o hospital — por isso o histórico é por convênio + material
function chaveNegativa(convenio, material) {
  return `${convenio}::${material.trim().toLowerCase()}`;
}

async function salvarNegativa({ hospital, convenio, codigo, material, motivo }) {
  const data = load();
  const chave = chaveNegativa(convenio, material);
  const lista = data.negativas[chave] || [];
  lista.push({ hospital, codigo, motivo, data: new Date().toISOString() });
  data.negativas[chave] = lista;
  save(data);
}

async function getNegativas(convenio, material) {
  const data = load();
  return data.negativas[chaveNegativa(convenio, material)] || [];
}

module.exports = {
  getPacote,
  salvarPacote,
  getExemplos,
  salvarExemplo,
  getPaciente,
  listarPacientes,
  salvarPedidoPaciente,
  salvarLaudoPaciente,
  salvarNegativa,
  getNegativas,
};

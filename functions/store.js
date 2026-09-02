// Adaptador Firestore — mesma interface do server/store.js (JSON local),
// para que index.js use exatamente a mesma lógica de rotas.

const { getFirestore } = require("firebase-admin/firestore");
const db = () => getFirestore();

function slug(s) {
  return String(s).trim().toLowerCase().replace(/[\/\.\#\$\[\]]/g, "_");
}

// ---------- Pacotes por hospital ----------
async function getPacote(hospital, codigo) {
  const doc = await db().collection("pacotes").doc(slug(`${hospital}::${codigo}`)).get();
  return doc.exists ? doc.data() : null;
}

async function salvarPacote(hospital, codigo, descricao) {
  const ref = db().collection("pacotes").doc(slug(`${hospital}::${codigo}`));
  const doc = await ref.get();
  const atual = doc.exists ? doc.data() : { descricao, ocorrencias: 0 };
  atual.ocorrencias = (atual.ocorrencias || 0) + 1;
  atual.descricao = descricao;
  atual.ultimaVez = new Date().toISOString();
  await ref.set(atual);
  return atual;
}

// ---------- Exemplos aprendidos (few-shot / auto-promote) ----------
async function getExemplos(material) {
  const doc = await db().collection("exemplos").doc(slug(material)).get();
  return doc.exists ? doc.data().lista || [] : [];
}

async function salvarExemplo({ material, entrada, saida, nivelEvidencia, correto }) {
  const ref = db().collection("exemplos").doc(slug(material));
  const doc = await ref.get();
  const lista = doc.exists ? doc.data().lista || [] : [];

  const existente = lista.find((e) => e.saida === saida);
  if (existente) {
    existente.confirmacoes += correto ? 1 : -1;
  } else {
    lista.push({ entrada, saida, nivelEvidencia, confirmacoes: correto ? 1 : 0 });
  }
  lista.forEach((e) => (e.confianca = Math.max(0, Math.min(1, e.confirmacoes / 5))));

  await ref.set({ lista });
}

// ---------- Pacientes ----------
async function getPaciente(nome) {
  const doc = await db().collection("pacientes").doc(slug(nome)).get();
  return doc.exists ? doc.data() : null;
}

async function listarPacientes() {
  const snap = await db().collection("pacientes").get();
  return snap.docs.map((d) => {
    const p = d.data();
    const pedidos = p.pedidos || [];
    const ultimo = pedidos.length ? pedidos[pedidos.length - 1] : null;
    return {
      nome: p.nome,
      ultimoPedido: ultimo ? ultimo.data : null,
      ultimoDiagnostico: ultimo ? ultimo.diagnostico : null,
    };
  });
}

async function salvarPedidoPaciente(nome, pedido) {
  if (!nome) return;
  const ref = db().collection("pacientes").doc(slug(nome));
  const doc = await ref.get();
  const atual = doc.exists ? doc.data() : { nome, criadoEm: new Date().toISOString(), pedidos: [], laudos: [] };
  atual.pedidos = atual.pedidos || [];
  atual.pedidos.push({ data: new Date().toISOString(), ...pedido });
  await ref.set(atual);
}

async function salvarLaudoPaciente(nome, laudo) {
  if (!nome) return;
  const ref = db().collection("pacientes").doc(slug(nome));
  const doc = await ref.get();
  const atual = doc.exists ? doc.data() : { nome, criadoEm: new Date().toISOString(), pedidos: [], laudos: [] };
  atual.laudos = atual.laudos || [];
  atual.laudos.push({ data: new Date().toISOString(), ...laudo });
  await ref.set(atual);
}

async function excluirPaciente(nome) {
  if (!nome) return;
  await db().collection("pacientes").doc(slug(nome)).delete();
}

// ---------- Negativas de convênio (aprendizado preventivo) ----------
async function salvarNegativa({ hospital, convenio, codigo, material, motivo }) {
  const ref = db().collection("negativas").doc(slug(`${convenio}::${material}`));
  const doc = await ref.get();
  const lista = doc.exists ? doc.data().lista || [] : [];
  lista.push({ hospital, codigo, motivo, data: new Date().toISOString() });
  await ref.set({ lista });
}

async function getNegativas(convenio, material) {
  const doc = await db().collection("negativas").doc(slug(`${convenio}::${material}`)).get();
  return doc.exists ? doc.data().lista || [] : [];
}

// ---------- Estatísticas de aprendizado / economia de chamadas de IA ----------
async function registrarUsoCache() {
  const ref = db().collection("stats").doc("geral");
  const doc = await ref.get();
  const atual = doc.exists ? doc.data() : { chamadasEconomizadas: 0 };
  atual.chamadasEconomizadas = (atual.chamadasEconomizadas || 0) + 1;
  atual.ultimaAtualizacao = new Date().toISOString();
  await ref.set(atual);
}

async function estatisticasAprendizado() {
  const snap = await db().collection("exemplos").get();
  let totalRespostasConfirmadas = 0;
  let materiaisAutonomos = 0;

  snap.forEach((doc) => {
    const lista = doc.data().lista || [];
    totalRespostasConfirmadas += lista.length;
    if (lista.some((e) => (e.confianca || 0) >= 0.9)) materiaisAutonomos += 1;
  });

  const statsDoc = await db().collection("stats").doc("geral").get();
  const chamadasEconomizadas = statsDoc.exists ? statsDoc.data().chamadasEconomizadas || 0 : 0;
  const ultimaAtualizacao = statsDoc.exists ? statsDoc.data().ultimaAtualizacao || null : null;

  return {
    totalMateriaisComExemplo: snap.size,
    totalRespostasConfirmadas,
    materiaisAutonomos,
    chamadasEconomizadas,
    ultimaAtualizacao,
  };
}

// ---------- Materiais cadastrados (lista reaproveitável em pedidos futuros) ----------
async function listarMateriaisCadastrados() {
  const snap = await db().collection("materiaisCadastrados").orderBy("nome").get();
  return snap.docs.map((d) => d.data().nome);
}

async function salvarMaterialCadastrado(nome) {
  if (!nome) return;
  await db().collection("materiaisCadastrados").doc(slug(nome)).set({ nome, criadoEm: new Date().toISOString() });
}

async function excluirMaterialCadastrado(nome) {
  if (!nome) return;
  await db().collection("materiaisCadastrados").doc(slug(nome)).delete();
}

// ---------- Procedimentos cadastrados (combo salvo de códigos + materiais) ----------
async function listarProcedimentos() {
  const snap = await db().collection("procedimentos").orderBy("nome").get();
  return snap.docs.map((d) => d.data());
}

async function salvarProcedimento({ nome, codigos, materiais }) {
  if (!nome) return;
  await db()
    .collection("procedimentos")
    .doc(slug(nome))
    .set({ nome, codigos: codigos || [], materiais: materiais || [], criadoEm: new Date().toISOString() });
}

async function getProcedimento(nome) {
  const doc = await db().collection("procedimentos").doc(slug(nome)).get();
  return doc.exists ? doc.data() : null;
}

async function excluirProcedimento(nome) {
  if (!nome) return;
  await db().collection("procedimentos").doc(slug(nome)).delete();
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
  excluirPaciente,
  salvarNegativa,
  getNegativas,
  registrarUsoCache,
  estatisticasAprendizado,
  listarMateriaisCadastrados,
  salvarMaterialCadastrado,
  excluirMaterialCadastrado,
  listarProcedimentos,
  salvarProcedimento,
  getProcedimento,
  excluirProcedimento,
};

// ---------- Backend (Cloud Function no Firebase) ----------
const API_BASE = "https://southamerica-east1-ortoai-pedidos.cloudfunctions.net/api";

// ---------- Registro do service worker com atualização automática ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      // Checa se há versão nova toda vez que o app abre
      reg.update().catch(() => {});

      reg.addEventListener("updatefound", () => {
        const novoWorker = reg.installing;
        novoWorker.addEventListener("statechange", () => {
          if (novoWorker.state === "installed" && navigator.serviceWorker.controller) {
            // Já tem uma versão nova pronta — manda ela assumir na hora
            novoWorker.postMessage("SKIP_WAITING");
          }
        });
      });
    }).catch(() => {});
  });

  // Quando a nova versão assume o controle, recarrega a página automaticamente
  let jaRecarregou = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (jaRecarregou) return;
    jaRecarregou = true;
    window.location.reload();
  });
}

// ---------- Estado ----------
const state = {
  paciente: "",
  diagnostico: "",
  hospital: "",
  convenio: "",
  codigos: [],
  materiais: [],
};

// ---------- Navegação (com histórico do navegador — o botão/gesto voltar do celular
// deve trocar de tela dentro do app, nunca sair dele) ----------
const mainRail = document.getElementById("main-rail");
const TELAS_NUMERADAS = ["1", "2", "3"];

function mostrarTela(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(`screen-${id}`).classList.add("active");

  const ehNumerada = TELAS_NUMERADAS.includes(String(id));
  mainRail.style.display = ehNumerada ? "flex" : "none";
  document.getElementById("bottom-bar").style.display = id === "3" ? "flex" : "none";

  if (ehNumerada) {
    document.querySelectorAll(".rail-step").forEach((r) => {
      const step = Number(r.dataset.step);
      r.classList.toggle("active", step === Number(id));
      r.classList.toggle("done", step < Number(id));
    });
  }
}

function navegarPara(id) {
  mostrarTela(id);
  history.pushState({ tela: String(id) }, "", location.href);
}

function voltar() {
  history.back();
}

window.addEventListener("popstate", (e) => {
  mostrarTela(e.state && e.state.tela ? e.state.tela : "1");
});

history.replaceState({ tela: "1" }, "", location.href);

// Mantido por compatibilidade com o restante do código
function goToStep(n) {
  navegarPara(String(n));
}

document.getElementById("to-step-2").addEventListener("click", () => {
  state.paciente = document.getElementById("paciente").value.trim();
  state.diagnostico = document.getElementById("diagnostico").value.trim();
  state.hospital = document.getElementById("hospital").value.trim();
  state.convenio = document.getElementById("convenio").value.trim();
  if (!state.diagnostico) {
    document.getElementById("diagnostico").focus();
    return;
  }
  navegarPara("2");
});

document.getElementById("back-to-1").addEventListener("click", voltar);
document.getElementById("back-to-2").addEventListener("click", voltar);

document.getElementById("open-negativa").addEventListener("click", () => navegarPara("negativa"));
document.getElementById("close-negativa").addEventListener("click", voltar);

document.getElementById("open-estatisticas").addEventListener("click", async () => {
  navegarPara("estatisticas");
  await carregarEstatisticas();
});
document.getElementById("close-estatisticas").addEventListener("click", voltar);

async function carregarEstatisticas() {
  const container = document.getElementById("estatisticas-conteudo");
  container.innerHTML = `<p class="suggestion-text">Carregando...</p>`;

  try {
    const resp = await fetch(`${API_BASE}/estatisticas`);
    const s = await resp.json();

    const ultimaData = s.ultimaAtualizacao ? new Date(s.ultimaAtualizacao).toLocaleString("pt-BR") : "ainda não houve economia registrada";

    container.innerHTML = `
      <div class="card">
        <div class="meta">Chamadas de IA economizadas</div>
        <h3>${s.chamadasEconomizadas || 0}</h3>
        <p class="suggestion-text">Vezes que o OrtoAI usou uma resposta já aprendida em vez de chamar o Gemini/Groq de novo.</p>
      </div>
      <div class="card">
        <div class="meta">Estimativa de tokens economizados</div>
        <h3>${(s.tokensEconomizadosEstimados || 0).toLocaleString("pt-BR")}</h3>
        <p class="suggestion-text">Estimativa aproximada — não é uma contagem exata de tokens.</p>
      </div>
      <div class="card">
        <div class="meta">Materiais já aprendidos</div>
        <h3>${s.totalMateriaisComExemplo || 0}</h3>
        <p class="suggestion-text">${s.materiaisAutonomos || 0} já respondem automaticamente (confiança ≥ 90%), com base em ${s.totalRespostasConfirmadas || 0} confirmações registradas.</p>
      </div>
      <div class="card">
        <div class="meta">Última economia registrada</div>
        <p class="suggestion-text">${ultimaData}</p>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="suggestion-text">Não foi possível carregar as estatísticas (${err.message}).</p>`;
  }
}

// ---------- Tela de Configurações (materiais e procedimentos cadastrados) ----------
document.getElementById("open-config").addEventListener("click", async () => {
  navegarPara("config");
  document.getElementById("config-nome-procedimento").value = "";
  document.getElementById("config-code-list").innerHTML = "";
  document.getElementById("config-material-list").innerHTML = "";
  addRow("config-code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
  addRow("config-material-list", { placeholderMain: "Ex: Âncora de sutura 5.5mm titânio", withCode: false });
  await Promise.all([carregarMateriaisCadastrados(), carregarProcedimentosCadastrados()]);
});
document.getElementById("close-config").addEventListener("click", voltar);

document.getElementById("config-add-code").addEventListener("click", () => {
  addRow("config-code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
});
document.getElementById("config-add-material").addEventListener("click", () => {
  addRow("config-material-list", { placeholderMain: "Ex: Âncora de sutura 5.5mm titânio", withCode: false });
});

document.getElementById("config-salvar-procedimento").addEventListener("click", async () => {
  const nome = document.getElementById("config-nome-procedimento").value.trim();
  if (!nome) {
    alert("Digite um nome para o procedimento.");
    return;
  }
  const codigos = collectRows("config-code-list", true);
  const materiais = collectRows("config-material-list", false);
  if (!codigos.length && !materiais.length) {
    alert("Adicione ao menos um código ou material antes de salvar.");
    return;
  }
  try {
    await fetch(`${API_BASE}/procedimentos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, codigos, materiais }),
    });
    document.getElementById("config-nome-procedimento").value = "";
    document.getElementById("config-code-list").innerHTML = "";
    document.getElementById("config-material-list").innerHTML = "";
    addRow("config-code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
    addRow("config-material-list", { placeholderMain: "Ex: Âncora de sutura 5.5mm titânio", withCode: false });
    carregarProcedimentosCadastrados();
  } catch (err) {
    alert(`Não foi possível salvar (${err.message}).`);
  }
});

async function atualizarDatalistMateriais() {
  try {
    const resp = await fetch(`${API_BASE}/materiais`);
    const materiais = await resp.json();
    const datalist = document.getElementById("materiais-datalist");
    if (datalist) datalist.innerHTML = materiais.map((m) => `<option value="${m}"></option>`).join("");
  } catch (err) {
    // sem problema — o campo continua funcionando normalmente, só sem sugestão automática
  }
}
atualizarDatalistMateriais();

async function carregarMateriaisCadastrados() {
  const lista = document.getElementById("materiais-cadastrados-lista");
  lista.innerHTML = `<p class="suggestion-text">Carregando...</p>`;
  try {
    const resp = await fetch(`${API_BASE}/materiais`);
    const materiais = await resp.json();
    if (!materiais.length) {
      lista.innerHTML = `<p class="suggestion-text">Nenhum material cadastrado ainda.</p>`;
      return;
    }
    lista.innerHTML = "";
    materiais.forEach((nome) => {
      const row = document.createElement("div");
      row.className = "code-row";
      row.innerHTML = `<input type="text" value="${nome}" disabled style="flex:1;" />`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", async () => {
        await fetch(`${API_BASE}/materiais/${encodeURIComponent(nome)}`, { method: "DELETE" });
        carregarMateriaisCadastrados();
        atualizarDatalistMateriais();
      });
      row.appendChild(removeBtn);
      lista.appendChild(row);
    });
  } catch (err) {
    lista.innerHTML = `<p class="suggestion-text">Não foi possível carregar (${err.message}).</p>`;
  }
}

document.getElementById("add-material-cadastrado").addEventListener("click", async () => {
  const input = document.getElementById("novo-material-input");
  const nome = input.value.trim();
  if (!nome) return;
  await fetch(`${API_BASE}/materiais`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome }),
  });
  input.value = "";
  carregarMateriaisCadastrados();
  atualizarDatalistMateriais();
});

async function carregarProcedimentosCadastrados() {
  const lista = document.getElementById("procedimentos-cadastrados-lista");
  lista.innerHTML = `<p class="suggestion-text">Carregando...</p>`;
  try {
    const resp = await fetch(`${API_BASE}/procedimentos`);
    const procedimentos = await resp.json();
    if (!procedimentos.length) {
      lista.innerHTML = `<p class="suggestion-text">Nenhum procedimento cadastrado ainda.</p>`;
      return;
    }
    lista.innerHTML = "";
    procedimentos.forEach((p) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>${p.nome}</h3><p class="suggestion-text">${p.codigos.length} código(s), ${p.materiais.length} material(is)</p>`;
      const excluirBtn = document.createElement("button");
      excluirBtn.type = "button";
      excluirBtn.className = "btn-ghost";
      excluirBtn.style.color = "var(--risk)";
      excluirBtn.textContent = "🗑️ Excluir";
      excluirBtn.addEventListener("click", async () => {
        await fetch(`${API_BASE}/procedimentos/${encodeURIComponent(p.nome)}`, { method: "DELETE" });
        carregarProcedimentosCadastrados();
      });
      card.appendChild(excluirBtn);
      lista.appendChild(card);
    });
  } catch (err) {
    lista.innerHTML = `<p class="suggestion-text">Não foi possível carregar (${err.message}).</p>`;
  }
}

// ---------- Usar / salvar procedimento (na etapa Código & material) ----------
document.getElementById("usar-procedimento").addEventListener("click", async () => {
  const picker = document.getElementById("procedimento-picker");
  if (picker.style.display === "block") {
    picker.style.display = "none";
    return;
  }
  picker.style.display = "block";
  picker.innerHTML = `<p class="suggestion-text">Carregando...</p>`;
  try {
    const resp = await fetch(`${API_BASE}/procedimentos`);
    const procedimentos = await resp.json();
    if (!procedimentos.length) {
      picker.innerHTML = `<p class="suggestion-text">Nenhum procedimento cadastrado ainda.</p>`;
      return;
    }
    picker.innerHTML = `<p class="suggestion-text" style="margin-bottom:8px;">Toque num procedimento abaixo para carregar os códigos e materiais dele:</p>`;
    procedimentos.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-add";
      btn.style.marginBottom = "6px";
      btn.textContent = `${p.nome} (${p.codigos.length} cód., ${p.materiais.length} mat.)`;
      btn.addEventListener("click", () => {
        (p.codigos || []).forEach((c) => {
          addRow("code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
          const linha = document.getElementById("code-list").lastElementChild;
          linha.querySelector(".tuss").value = c.codigo;
          linha.querySelector("input:not(.tuss)").value = c.descricao;
        });
        (p.materiais || []).forEach((m) => {
          addRow("material-list", { placeholderMain: "Ex: Âncora de sutura 5.5mm titânio", withCode: false });
          const linha = document.getElementById("material-list").lastElementChild;
          linha.querySelector("input").value = m.descricao;
        });
        picker.style.display = "none";
      });
      picker.appendChild(btn);
    });
  } catch (err) {
    picker.innerHTML = `<p class="suggestion-text">Não foi possível carregar (${err.message}).</p>`;
  }
});

document.getElementById("salvar-procedimento").addEventListener("click", async () => {
  const nome = prompt("Nome deste procedimento (ex: Reconstrução de LCA padrão):");
  if (!nome) return;
  const codigos = collectRows("code-list", true);
  const materiais = collectRows("material-list", false);
  if (!codigos.length && !materiais.length) {
    alert("Adicione ao menos um código ou material antes de salvar.");
    return;
  }
  try {
    await fetch(`${API_BASE}/procedimentos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, codigos, materiais }),
    });
    alert("Procedimento salvo!");
  } catch (err) {
    alert(`Não foi possível salvar (${err.message}).`);
  }
});

document.getElementById("open-pacientes").addEventListener("click", async () => {
  navegarPara("pacientes");
  await carregarPacientes();
});

document.getElementById("close-pacientes").addEventListener("click", voltar);

let todosPacientes = [];

async function carregarPacientes() {
  const lista = document.getElementById("pacientes-lista");
  const detalhe = document.getElementById("paciente-detalhe");
  const busca = document.getElementById("busca-paciente");
  busca.value = "";
  detalhe.style.display = "none";
  detalhe.innerHTML = "";
  lista.style.display = "block";
  lista.innerHTML = `<p class="suggestion-text">Carregando...</p>`;

  try {
    const resp = await fetch(`${API_BASE}/pacientes`);
    const pacientes = await resp.json();
    todosPacientes = Array.isArray(pacientes) ? pacientes : [];
    renderizarListaPacientes(todosPacientes);
  } catch (err) {
    lista.innerHTML = `<p class="suggestion-text">Não foi possível carregar os pacientes (${err.message}).</p>`;
  }
}

function renderizarListaPacientes(pacientes) {
  const lista = document.getElementById("pacientes-lista");

  if (!pacientes.length) {
    lista.innerHTML = `<p class="suggestion-text">Nenhum paciente encontrado.</p>`;
    return;
  }

  lista.innerHTML = "";
  pacientes.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";
    const ultimo = p.ultimoPedido ? new Date(p.ultimoPedido).toLocaleDateString("pt-BR") : "sem pedidos ainda";
    card.innerHTML = `
      <h3>${p.nome}</h3>
      <p class="suggestion-text">Último pedido: ${ultimo}</p>
      ${p.ultimoDiagnostico ? `<p class="suggestion-text">${p.ultimoDiagnostico}</p>` : ""}
    `;
    card.addEventListener("click", () => abrirDetalhePaciente(p.nome));
    lista.appendChild(card);
  });
}

document.getElementById("busca-paciente").addEventListener("input", (e) => {
  const termo = e.target.value.trim().toLowerCase();
  if (!termo) {
    renderizarListaPacientes(todosPacientes);
    return;
  }
  const filtrados = todosPacientes.filter(
    (p) =>
      p.nome.toLowerCase().includes(termo) ||
      (p.ultimoDiagnostico && p.ultimoDiagnostico.toLowerCase().includes(termo))
  );
  renderizarListaPacientes(filtrados);
});

async function abrirDetalhePaciente(nome) {
  const lista = document.getElementById("pacientes-lista");
  const detalhe = document.getElementById("paciente-detalhe");
  lista.style.display = "none";
  detalhe.style.display = "block";
  detalhe.innerHTML = `<p class="suggestion-text">Carregando...</p>`;

  try {
    const resp = await fetch(`${API_BASE}/pacientes/${encodeURIComponent(nome)}`);
    const p = await resp.json();

    const pedidosHtml = (p.pedidos || [])
      .slice()
      .reverse()
      .map(
        (ped) => `
      <div class="card">
        <div class="meta">${new Date(ped.data).toLocaleString("pt-BR")}</div>
        <p class="suggestion-text">${ped.diagnostico || ""}</p>
        <p class="suggestion-text">${ped.hospital || ""}${ped.convenio ? " — " + ped.convenio : ""}</p>
      </div>`
      )
      .join("");

    const laudosHtml = (p.laudos || [])
      .slice()
      .reverse()
      .map(
        (l) => `
      <div class="card">
        <div class="meta">${new Date(l.data).toLocaleString("pt-BR")} — laudo lido</div>
        <p class="suggestion-text">${l.textoExtraido || ""}</p>
      </div>`
      )
      .join("");

    detalhe.innerHTML = `
      <button class="btn-ghost" id="voltar-lista-pacientes">← Todos os pacientes</button>
      <h3 style="margin-top:14px;">${p.nome}</h3>
      <p class="suggestion-text" style="margin-bottom:14px;">Cadastrado em ${new Date(p.criadoEm).toLocaleDateString("pt-BR")}</p>
      ${pedidosHtml || `<p class="suggestion-text">Nenhum pedido registrado.</p>`}
      ${laudosHtml}
      <button class="btn-ghost" id="excluir-paciente" style="color:var(--risk); margin-top:20px;">🗑️ Excluir paciente</button>
    `;
    document.getElementById("voltar-lista-pacientes").addEventListener("click", () => {
      detalhe.style.display = "none";
      lista.style.display = "block";
    });
    document.getElementById("excluir-paciente").addEventListener("click", async () => {
      if (!confirm(`Excluir permanentemente "${p.nome}" e todo o histórico de pedidos e laudos? Isso não pode ser desfeito.`)) return;
      try {
        await fetch(`${API_BASE}/pacientes/${encodeURIComponent(nome)}`, { method: "DELETE" });
        detalhe.style.display = "none";
        await carregarPacientes();
      } catch (err) {
        alert(`Não foi possível excluir (${err.message}).`);
      }
    });
  } catch (err) {
    detalhe.innerHTML = `<p class="suggestion-text">Não foi possível carregar este paciente (${err.message}).</p>`;
  }
}

// ---------- Utilitário: arquivo -> base64 ----------
function arquivoParaBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- Leitura do laudo de RM pela câmera ou galeria ----------
async function processarLaudo(file) {
  if (!file) return;

  const status = document.getElementById("laudo-status");
  const resultBox = document.getElementById("laudo-result");
  status.style.display = "flex";
  status.classList.remove("erro");
  status.textContent = "Lendo laudo…";
  resultBox.style.display = "none";

  const campoPaciente = document.getElementById("paciente");
  const campoDiagnostico = document.getElementById("diagnostico");
  const diagnosticoJaPreenchido = campoDiagnostico.value.trim();

  try {
    const imagemBase64 = await arquivoParaBase64(file);
    const resp = await fetch(`${API_BASE}/laudo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paciente: campoPaciente.value.trim(),
        imagemBase64,
        mimeType: file.type,
        diagnosticoDigitado: diagnosticoJaPreenchido,
      }),
    });
    const data = await resp.json();

    if (!campoPaciente.value.trim() && data.nomePaciente && data.nomePaciente !== "não identificado") {
      campoPaciente.value = data.nomePaciente;
    }
    if (!diagnosticoJaPreenchido && data.diagnosticoSugerido) {
      campoDiagnostico.value = data.diagnosticoSugerido;
    }

    status.style.display = "none";
    resultBox.style.display = "block";

    const temIncoerencia = data.incoerencias && data.incoerencias.length > 0;
    resultBox.innerHTML = `
      <div class="laudo-card">
        <div class="meta">${data.demo ? "Modo demonstração — laudo" : "Laudo lido"}</div>
        <p>${data.textoExtraido}</p>
        ${
          !diagnosticoJaPreenchido
            ? `<ul class="incoerencias ok"><li>Diagnóstico preenchido automaticamente a partir do laudo — revise antes de continuar.</li></ul>`
            : temIncoerencia
            ? `<ul class="incoerencias">${data.incoerencias.map((i) => `<li>${i}</li>`).join("")}</ul>`
            : `<ul class="incoerencias ok"><li>Nenhuma incoerência encontrada com o diagnóstico digitado.</li></ul>`
        }
      </div>`;
  } catch (err) {
    status.style.display = "flex";
    status.classList.add("erro");
    status.textContent = `Não foi possível ler o laudo (${err.message}).`;
  }
}

document.getElementById("laudo-input-camera").addEventListener("change", (e) => processarLaudo(e.target.files[0]));
document.getElementById("laudo-input-galeria").addEventListener("change", (e) => processarLaudo(e.target.files[0]));

// ---------- Registro de negativa por foto (câmera ou galeria) ----------
async function processarNegativa(file) {
  if (!file) return;

  const hospital = document.getElementById("neg-hospital").value.trim();
  const convenio = document.getElementById("neg-convenio").value.trim();
  const material = document.getElementById("neg-material").value.trim();
  const codigo = document.getElementById("neg-codigo").value.trim();
  const status = document.getElementById("negativa-status");
  const resultBox = document.getElementById("negativa-result");

  if (!convenio || !material) {
    status.style.display = "flex";
    status.classList.add("erro");
    status.textContent = "Preencha convênio e material antes de fotografar.";
    document.getElementById("negativa-input-camera").value = "";
    document.getElementById("negativa-input-galeria").value = "";
    return;
  }

  status.style.display = "flex";
  status.classList.remove("erro");
  status.textContent = "Lendo negativa…";
  resultBox.style.display = "none";

  try {
    const imagemBase64 = await arquivoParaBase64(file);
    const resp = await fetch(`${API_BASE}/negativa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hospital, convenio, codigo, material, imagemBase64, mimeType: file.type }),
    });
    const data = await resp.json();

    status.style.display = "none";
    resultBox.style.display = "block";
    resultBox.innerHTML = `
      <div class="laudo-card">
        <div class="meta">Motivo registrado</div>
        <p>${data.motivoExtraido}</p>
      </div>`;
  } catch (err) {
    status.style.display = "flex";
    status.classList.add("erro");
    status.textContent = `Não foi possível registrar a negativa (${err.message}).`;
  }
}

document.getElementById("negativa-input-camera").addEventListener("change", (e) => processarNegativa(e.target.files[0]));
document.getElementById("negativa-input-galeria").addEventListener("change", (e) => processarNegativa(e.target.files[0]));

// ---------- Listas dinâmicas: códigos TUSS e materiais ----------
function addRow(containerId, { placeholderMain, placeholderCode, withCode }) {
  const container = document.getElementById(containerId);
  const row = document.createElement("div");
  row.className = "code-row";

  if (withCode) {
    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.className = "tuss";
    codeInput.placeholder = placeholderCode;
    row.appendChild(codeInput);
  }

  const mainInput = document.createElement("input");
  mainInput.type = "text";
  mainInput.placeholder = placeholderMain;
  if (!withCode) mainInput.setAttribute("list", "materiais-datalist");
  row.appendChild(mainInput);

  if (withCode && typeof TABELA_TUSS !== "undefined") {
    const codeInput = row.querySelector(".tuss");
    codeInput.addEventListener("input", () => {
      const codigo = codeInput.value.trim();
      const descricaoConhecida = TABELA_TUSS[codigo];
      if (descricaoConhecida) mainInput.value = descricaoConhecida;
    });
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "Remover");
  removeBtn.textContent = "✕";
  removeBtn.className = "btn-remove";
  removeBtn.addEventListener("click", () => row.remove());
  row.appendChild(removeBtn);

  container.appendChild(row);
}

// ---------- Sugestão automática de código por tipo de cirurgia ----------
async function aplicarSugestaoCirurgia(tipo) {
  document.getElementById("tipo-aberta").classList.toggle("ativo-tipo", tipo === "aberta");
  document.getElementById("tipo-artro").classList.toggle("ativo-tipo", tipo === "artroscopica");
  document.getElementById("tipo-bloqueio").classList.toggle("ativo-tipo", tipo === "bloqueio");

  const diagnostico = document.getElementById("diagnostico").value.trim();
  const status = document.getElementById("sugestao-codigos-status");
  const picker = document.getElementById("sugestao-codigos-picker");
  picker.style.display = "none";
  picker.innerHTML = "";

  if (!diagnostico) {
    status.style.display = "flex";
    status.classList.add("erro");
    status.textContent = "Preencha o diagnóstico na etapa anterior para receber sugestões.";
    return;
  }

  status.style.display = "flex";
  status.classList.remove("erro");
  status.textContent = tipo === "bloqueio" ? "Analisando diagnóstico para escolher os nervos mais adequados..." : "Buscando sugestões...";

  let sugestoes = [];
  if (tipo === "bloqueio") {
    try {
      const resp = await fetch(`${API_BASE}/sugerir-bloqueio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnostico }),
      });
      const data = await resp.json();
      sugestoes = data.codigos || [];
    } catch (err) {
      sugestoes = typeof sugerirCodigosTuss === "function" ? sugerirCodigosTuss(diagnostico, tipo) : [];
    }
  } else {
    sugestoes = typeof sugerirCodigosTuss === "function" ? sugerirCodigosTuss(diagnostico, tipo) : [];
  }

  if (!sugestoes.length) {
    status.textContent = "Nenhuma sugestão automática encontrada para este diagnóstico — adicione o código manualmente.";
    return;
  }

  status.textContent = `${sugestoes.length} sugestão(ões) encontrada(s) — marque as que quiser adicionar:`;

  picker.style.display = "block";
  sugestoes.forEach((s) => {
    const label = document.createElement("label");
    label.style.cssText = "display:flex; align-items:flex-start; gap:10px; padding:8px 0; font-size:0.88rem; border-bottom:1px solid var(--border);";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.style.marginTop = "3px";
    check.dataset.codigo = s.codigo;
    check.dataset.descricao = s.descricao;
    const texto = document.createElement("span");
    texto.innerHTML = `${s.descricao}<span class="meta" style="display:block; margin-top:2px;">${s.codigo}</span>`;
    label.appendChild(check);
    label.appendChild(texto);
    picker.appendChild(label);
  });

  const btnAdicionar = document.createElement("button");
  btnAdicionar.type = "button";
  btnAdicionar.className = "btn-primary";
  btnAdicionar.style.marginTop = "12px";
  btnAdicionar.textContent = "Adicionar selecionados";
  btnAdicionar.addEventListener("click", () => {
    let adicionados = 0;
    picker.querySelectorAll('input[type="checkbox"]:checked').forEach((chk) => {
      addRow("code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
      const linha = document.getElementById("code-list").lastElementChild;
      linha.querySelector(".tuss").value = chk.dataset.codigo;
      linha.querySelector("input:not(.tuss)").value = chk.dataset.descricao;
      adicionados++;
    });
    picker.style.display = "none";
    status.textContent = `${adicionados} código(s) adicionado(s) — revise, edite ou remova conforme necessário.`;
  });
  picker.appendChild(btnAdicionar);
}

document.getElementById("tipo-aberta").addEventListener("click", () => aplicarSugestaoCirurgia("aberta"));
document.getElementById("tipo-artro").addEventListener("click", () => aplicarSugestaoCirurgia("artroscopica"));
document.getElementById("tipo-bloqueio").addEventListener("click", () => aplicarSugestaoCirurgia("bloqueio"));

document.getElementById("add-code").addEventListener("click", () => {
  addRow("code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
});
document.getElementById("add-material").addEventListener("click", () => {
  addRow("material-list", { placeholderMain: "Ex: Âncora de sutura 5.5mm titânio", withCode: false });
});

addRow("code-list", { placeholderMain: "Descrição do procedimento", placeholderCode: "Código", withCode: true });
addRow("material-list", { placeholderMain: "Ex: Âncora de sutura 5.5mm titânio", withCode: false });

function collectRows(containerId, withCode) {
  const rows = [...document.querySelectorAll(`#${containerId} .code-row`)];
  return rows
    .map((row) => {
      const inputs = row.querySelectorAll("input");
      return withCode
        ? { codigo: inputs[0].value.trim(), descricao: inputs[1].value.trim() }
        : { descricao: inputs[0].value.trim() };
    })
    .filter((item) => item.descricao);
}

// ---------- Etapa 3: gerar parecer ----------
document.getElementById("to-step-3").addEventListener("click", async () => {
  state.codigos = collectRows("code-list", true);
  state.materiais = collectRows("material-list", false);

  if (!state.materiais.length) {
    alert("Adicione ao menos um material antes de gerar o parecer.");
    return;
  }

  navegarPara("3");
  document.getElementById("loading").style.display = "block";
  document.getElementById("result").style.display = "none";

  const parecer = await gerarParecer(state);

  document.getElementById("loading").style.display = "none";
  document.getElementById("result").style.display = "block";
  renderParecer(parecer);
});

async function gerarParecer(payload) {
  try {
    const resp = await fetch(`${API_BASE}/parecer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    return demoParecer(payload, err.message);
  }
}

function demoParecer(payload, motivoErro) {
  let motivo = "Backend ainda não conectado.";
  if (motivoErro) {
    const codigoHttp = parseInt((motivoErro.match(/HTTP (\d+)/) || [])[1], 10);
    if (codigoHttp >= 400 && codigoHttp < 500) {
      motivo = `O servidor recusou o pedido (${motivoErro}) — confira se diagnóstico e material estão preenchidos corretamente.`;
    } else {
      motivo = `Não foi possível falar com o servidor (${motivoErro}). Isso costuma ser tempo limite excedido — tente de novo com menos materiais de uma vez, ou aguarde um pouco.`;
    }
  }
  return {
    demo: true,
    itens: payload.materiais.length
      ? payload.materiais.map((m) => ({
          material: m.descricao,
          nivelEvidencia: "II",
          badge: "high",
          resumo: motivo,
        }))
      : [],
    alertaPacote: null,
    textoPedido: `[Demonstração] ${motivo}`,
  };
}

function renderParecer(parecer) {
  const container = document.getElementById("result");
  container.innerHTML = "";
  let ordem = 0;
  const proximoAtraso = () => `${(ordem++) * 90}ms`;

  if (parecer.demo) {
    const notice = document.createElement("div");
    notice.className = "card";
    notice.style.setProperty("--stagger", proximoAtraso());
    notice.innerHTML = `<span class="badge risk">Modo demonstração</span>
      <p class="suggestion-text" style="margin-top:10px;">Backend de busca (PubMed + IA) ainda não conectado neste ambiente.</p>`;
    container.appendChild(notice);
  }

  if (parecer.alertaPacote) {
    const alerta = document.createElement("div");
    alerta.className = "card";
    alerta.style.setProperty("--stagger", proximoAtraso());
    alerta.innerHTML = `<span class="badge risk">Atenção — pacote do hospital</span>
      <p class="suggestion-text" style="margin-top:10px;">${parecer.alertaPacote}</p>`;
    container.appendChild(alerta);
  }

  if (parecer.sugestaoCodigos) {
    const sugestao = document.createElement("div");
    sugestao.className = "card";
    sugestao.style.setProperty("--stagger", proximoAtraso());
    sugestao.innerHTML = `<span class="badge ok">Sugestão de código</span>
      <p class="suggestion-text" style="margin-top:10px;">${parecer.sugestaoCodigos}</p>`;
    container.appendChild(sugestao);
  }

  parecer.itens.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.setProperty("--stagger", proximoAtraso());
    card.innerHTML = `
      <span class="badge ${item.badge}">Nível ${item.nivelEvidencia}</span>
      ${item.alertaNegativaAnterior ? `<span class="badge risk" style="margin-left:6px;">Negativa anterior</span>` : ""}
      <h3>${item.material}</h3>
      ${evidenceLadder(item.nivelEvidencia)}
      <p class="suggestion-text">${item.resumo}</p>
      ${
        parecer.demo
          ? ""
          : `<button class="btn-ghost btn-confirmar" style="margin-top:10px;" data-material="${encodeURIComponent(item.material)}" data-resumo="${encodeURIComponent(item.resumo)}" data-nivel="${item.nivelEvidencia}">✓ Confirmar este parecer</button>`
      }
    `;
    container.appendChild(card);
  });

  container.querySelectorAll(".btn-confirmar").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const material = decodeURIComponent(btn.dataset.material);
      const resumo = decodeURIComponent(btn.dataset.resumo);
      const nivel = btn.dataset.nivel;
      btn.disabled = true;
      btn.textContent = "Enviando...";
      try {
        await fetch(`${API_BASE}/confirmar`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            material,
            entrada: state.diagnostico,
            saida: resumo,
            nivelEvidencia: nivel,
            correto: true,
          }),
        });
        btn.textContent = "✓ Confirmado — obrigado!";
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "✓ Confirmar este parecer";
      }
    });
  });

  const textCard = document.createElement("div");
  textCard.className = "card";
  textCard.style.setProperty("--stagger", proximoAtraso());
  textCard.innerHTML = `
    <div class="meta">Texto para a solicitação</div>
    <h3>Justificativa consolidada</h3>
    <p class="suggestion-text" id="pedido-text">${parecer.textoPedido}</p>
  `;
  container.appendChild(textCard);
}

function evidenceLadder(nivel) {
  const niveis = ["I", "II", "III", "IV", "V"];
  const idx = niveis.indexOf(nivel);
  return `<div class="evidence-ladder">
    ${niveis
      .map((n, i) => {
        const lit = idx >= 0 && i <= idx;
        return `<div class="rung ${lit ? "lit" : ""}">
          <span class="lvl">${n}</span>
          <span class="bar"></span>
          <span class="n">${i === 0 ? "meta-análise" : i === niveis.length - 1 ? "opinião" : ""}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

// ---------- Copiar texto do pedido ----------
document.getElementById("copy-text").addEventListener("click", () => {
  const el = document.getElementById("pedido-text");
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = document.getElementById("copy-text");
    const original = btn.textContent;
    btn.textContent = "Copiado ✓";
    setTimeout(() => (btn.textContent = original), 1600);
  });
});

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

// ---------- Navegação entre etapas ----------
function goToStep(n) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(`screen-${n}`).classList.add("active");

  document.querySelectorAll(".rail-step").forEach((r) => {
    const step = Number(r.dataset.step);
    r.classList.toggle("active", step === n);
    r.classList.toggle("done", step < n);
  });

  document.getElementById("bottom-bar").style.display = n === 3 ? "flex" : "none";
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
  goToStep(2);
});

document.getElementById("back-to-1").addEventListener("click", () => goToStep(1));
document.getElementById("back-to-2").addEventListener("click", () => goToStep(2));

// ---------- Tela de registrar negativa (fora do fluxo numerado) ----------
const mainRail = document.getElementById("main-rail");
let telaAnterior = 1;

document.getElementById("open-negativa").addEventListener("click", () => {
  telaAnterior = [...document.querySelectorAll(".screen")].findIndex((s) => s.classList.contains("active")) + 1;
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-negativa").classList.add("active");
  mainRail.style.display = "none";
  document.getElementById("bottom-bar").style.display = "none";
});

document.getElementById("close-negativa").addEventListener("click", () => {
  mainRail.style.display = "flex";
  goToStep(telaAnterior || 1);
});

// ---------- Tela de pacientes ----------
document.getElementById("open-pacientes").addEventListener("click", async () => {
  telaAnterior = [...document.querySelectorAll(".screen")].findIndex((s) => s.classList.contains("active")) + 1;
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-pacientes").classList.add("active");
  mainRail.style.display = "none";
  document.getElementById("bottom-bar").style.display = "none";
  await carregarPacientes();
});

document.getElementById("close-pacientes").addEventListener("click", () => {
  mainRail.style.display = "flex";
  goToStep(telaAnterior || 1);
});

async function carregarPacientes() {
  const lista = document.getElementById("pacientes-lista");
  const detalhe = document.getElementById("paciente-detalhe");
  detalhe.style.display = "none";
  detalhe.innerHTML = "";
  lista.style.display = "block";
  lista.innerHTML = `<p class="suggestion-text">Carregando...</p>`;

  try {
    const resp = await fetch(`${API_BASE}/pacientes`);
    const pacientes = await resp.json();

    if (!Array.isArray(pacientes) || !pacientes.length) {
      lista.innerHTML = `<p class="suggestion-text">Nenhum paciente registrado ainda — pedidos e laudos com o campo "Paciente" preenchido aparecem aqui.</p>`;
      return;
    }

    lista.innerHTML = "";
    pacientes.forEach((p) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      const ultimo = p.ultimoPedido ? new Date(p.ultimoPedido).toLocaleDateString("pt-BR") : "sem pedidos ainda";
      card.innerHTML = `<h3>${p.nome}</h3><p class="suggestion-text">Último pedido: ${ultimo}</p>`;
      card.addEventListener("click", () => abrirDetalhePaciente(p.nome));
      lista.appendChild(card);
    });
  } catch (err) {
    lista.innerHTML = `<p class="suggestion-text">Não foi possível carregar os pacientes (${err.message}).</p>`;
  }
}

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

  goToStep(3);
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
    if (!resp.ok) throw new Error("backend indisponível");
    return await resp.json();
  } catch (err) {
    return demoParecer(payload);
  }
}

function demoParecer(payload) {
  return {
    demo: true,
    itens: payload.materiais.length
      ? payload.materiais.map((m) => ({
          material: m.descricao,
          nivelEvidencia: "II",
          badge: "high",
          resumo:
            "Backend ainda não conectado — este é um texto de demonstração. Quando o servidor de busca (PubMed + IA) estiver no ar, aqui aparecerá a justificativa real com estudos citados.",
        }))
      : [],
    alertaPacote: null,
    textoPedido:
      "[Demonstração] Conecte o backend em /api/parecer para gerar o texto real de justificativa, com estudos e nível de evidência, pronto para colar na solicitação do hospital.",
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
    `;
    container.appendChild(card);
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

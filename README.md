# OrtoAI

App de pedido cirúrgico com justificativa científica automática, focado em cirurgia de joelho.
Objetivo: reduzir glosas de convênio, sugerindo códigos TUSS e comprovando a necessidade do
material com estudos de alto nível de evidência (PubMed) — sem nunca sugerir troca do material
informado, já que os materiais vêm de parcerias comerciais do cirurgião.

## Funcionalidades

- **Diagnóstico + laudo por câmera**: o médico digita o diagnóstico e pode fotografar o laudo
  de RM. A IA (Gemini Vision) transcreve os achados e aponta incoerências entre o laudo e o
  diagnóstico digitado.
- **Código & material**: TUSS propostos e materiais (fixos, não substituíveis).
- **Parecer**: busca PubMed + síntese Gemini, com escada de evidência (I–V), alerta de "pacote
  do hospital" e alerta de negativa anterior para o mesmo material/hospital.
- **Registrar negativa recebida** (ícone ⚠ no topo): fotografa a carta de negativa do convênio;
  a IA extrai o motivo alegado e guarda associado a hospital + material, para o próximo parecer
  já tentar neutralizar esse argumento.
- **Pacientes**: cada pedido e cada laudo lido ficam associados ao nome do paciente informado.

## Estrutura

```
ortoai/
├── index.html          # PWA — diagnóstico+laudo / código+material / parecer / negativa
├── manifest.json
├── service-worker.js   # cache do shell; chamadas /api/* sempre vão para a rede
├── css/style.css
├── js/app.js
├── icons/
└── server/
    ├── server.js        # PubMed + Gemini (texto e visão) + memória de pacote/negativa/aprendizado
    ├── store.js          # armazenamento (hoje JSON local; trocar por Firestore depois)
    ├── package.json
    └── .env.example
```

## Rotas do backend

- `POST /api/parecer` — gera o parecer (diagnóstico, hospital, códigos, materiais, paciente opcional)
- `POST /api/laudo` — lê a foto do laudo de RM e aponta incoerências com o diagnóstico digitado
- `POST /api/negativa` — lê a foto de uma negativa de convênio e registra o motivo
- `GET /api/pacientes` — lista pacientes cadastrados
- `GET /api/pacientes/:nome` — histórico de pedidos e laudos de um paciente
- `POST /api/confirmar` — confirma/corrige um parecer (alimenta o aprendizado few-shot)
- `POST /api/pacote` — registra manualmente que um código caiu em pacote de um hospital

## Rodando localmente

Frontend (qualquer servidor estático):
```
npx serve ortoai
```

Backend:
```
cd server
npm install
cp .env.example .env   # preencher GEMINI_API_KEY (reaproveitar a chave já usada no Audit AI/MedNote)
npm start
```

Sem o backend rodando, o app funciona em **modo demonstração** (front-end sozinho), deixando
isso explícito na tela de parecer e na leitura de laudo.

## Pendências conhecidas (próximos passos)

- [ ] Criar projeto Firebase isolado do OrtoAI (Firestore + Auth) — planejado para depois
- [ ] Trocar `server/store.js` por um adaptador Firestore, mantendo a mesma interface
  (`getPaciente`, `salvarPedidoPaciente`, `salvarLaudoPaciente`, `salvarNegativa`, `getNegativas`, etc.)
- [ ] Gerar token de acesso do GitHub e publicar em GitHub Pages
- [ ] Cadastro de paciente hoje é só pelo nome digitado (sem CPF/ID único) — dois pacientes com
  nome igual vão se misturar; decidir se usa CPF como identificador antes de ter uso real
- [ ] Tela de listagem/histórico de pacientes ainda não existe no frontend (o backend já suporta
  via `/api/pacientes`) — falta a interface para consultar pedidos e laudos anteriores
- [ ] Adicionar fluxo de confirmação/correção na tela de parecer (chama `/api/confirmar`),
      para alimentar o aprendizado few-shot → autônomo
- [ ] LGPD: dados de paciente e imagens de laudo/negativa ficam em texto puro no `store.json`
  local — antes de usar com pacientes reais, definir criptografia em repouso e política de
  retenção quando migrar para Firestore
- [ ] Refinar a heurística de nível de evidência (hoje simplificada) com base no tipo de
      estudo retornado pelo PubMed (revisão sistemática > meta-análise > RCT > coorte...)
- [ ] Considerar Groq como fallback do Gemini (mesmo padrão da Audit AI)
- [ ] Testar em rede real (PubMed/Gemini) — só validado localmente com fallback de demonstração,
  já que este ambiente de build não tem acesso à internet externa


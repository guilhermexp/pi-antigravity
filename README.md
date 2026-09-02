# pi-antigravity

Extensão oficial e nativa do **Google Antigravity** para o **`pi-cli`**. Permite acessar diretamente os modelos **Gemini 3.x**, **Claude (Sonnet / Opus 4.6)** e **GPT-OSS** via endpoints internos do Cloud Code Assist (`daily-cloudcode-pa.googleapis.com`), com **OAuth 2.0 PKCE**, **pool multi-contas**, **rotação automática de cotas (HTTP 429)** e **indicador de conta no footer**.

Sem necessidade de Quotio, proxies ou intermediários externos.

---

## 🚀 Instalação Rápida no `pi`

Em qualquer máquina com o `pi` instalado:

```bash
pi install git:github.com/guilhermexp/pi-antigravity
```

Ou usando URL HTTPS direta:

```bash
pi install https://github.com/guilhermexp/pi-antigravity
```

---

## 🧠 Modelos Suportados

| Modelo | Contexto | Max Output | Raciocínio (Thinking) | Visão (Imagens) |
| :--- | :--- | :--- | :--- | :--- |
| **`gemini-3.7-flash`** | 1.0M | 65.5K | ✅ Sim | ✅ Sim |
| **`gemini-3.5-flash`** | 1.0M | 65.5K | ✅ Sim | ✅ Sim |
| **`gemini-3.1-pro`** | 1.0M | 65.5K | ✅ Sim | ✅ Sim |
| **`claude-sonnet-4-6`** | 200K | 64K | ✅ Sim | ✅ Sim |
| **`claude-opus-4-6`** | 200K | 64K | ✅ Sim | ✅ Sim |
| **`gpt-oss-120b`** | 131K | 8.2K | ✅ Sim | ❌ Não |

---

## 🔑 Autenticação

Para conectar sua conta Google:

1. Abra o `pi` e digite:
   ```text
   /login
   ```
2. Selecione **`Antigravity (Gemini 3, Claude, GPT-OSS)`**.
3. Uma janela do navegador abrirá na porta `51121` para você autorizar sua conta Google.
4. A extensão provisiona automaticamente o tier gratuito (`v1internal:onboardUser`) e vincula o projeto.

---

## 🔄 Pool Multi-Contas & Auto-Rotação de Cotas

A extensão suporta múltiplas contas Google simultaneamente:

- **Rotação Automática (HTTP 429)**: Se a conta em uso atingir o limite semanal/sessão (`RESOURCE_EXHAUSTED` / `QUOTA_EXHAUSTED`), o `pi` marca a conta em cooldown de 5 minutos, seleciona imediatamente a próxima conta disponível com cota, atualiza o token via `refresh_token` e reenvia a requisição sem interromper o seu turno.
- **Menu de Contas**: Digite `/antigravity` para alternar manualmente a conta ativa.
- **Sincronização**: Digite `/antigravity sync` para importar contas já autenticadas no `omp` (`~/.omp/agent/agent.db`) ou Quotio (`~/.cli-proxy-api/`).

---

## 📌 E-mail no Footer

O e-mail da conta ativa é renderizado diretamente na barra de status inferior do `pi`:

```text
↑3.8M ↓1.2k R3.5M CH49.4% [seu-email@gmail.com] (google-antigravity) gemini-3.7-flash • medium
```

---

## 🛠️ Detalhes de Engenharia

- **Normalização de Schemas (`normalizeSchemaForCCA`)**: Sanitize automático de JSON schemas TypeBox do `pi`, eliminando combinadores (`anyOf`/`oneOf`/`allOf`) e campos incompatíveis com o validador draft 2020-12 do Claude.
- **Preservação de `thoughtSignature`**: Captura e reaplicação da assinatura de raciocínio no Gemini 3 em chamadas de ferramentas multi-turno.
- **Pareamento de IDs**: Injeção e correlação estrita de `id` para blocos `tool_use` e `tool_result` no Claude.
- **Header Dinâmico**: Descoberta automática da versão mais recente do Antigravity Hub via manifesto do auto-updater do Google.

---

## 📄 Licença

MIT © [Guilherme Varela](https://github.com/guilhermexp)

# Auditoria da conta Kommo

Script somente leitura (só faz GET na API v4) que mede como a conta funciona hoje:
funis e etapas, leads parados, conversão e ciclo, perdas e motivos, tarefas atrasadas,
tempo de primeira resposta no chat, origem dos leads, qualidade de dados, equipe e integrações.

## Rodar

```bash
KOMMO_TOKEN=eyJ... node auditoria/auditoria-kommo.mjs
```

Precisa de Node 22+. Sem dependências.

| Variável | Padrão | Para quê |
|---|---|---|
| `KOMMO_TOKEN` / `KOMMO_TOKEN_FILE` | | token de longa duração (eyJ...) |
| `KOMMO_DOMAIN` | `api_domain` do token | `https://<conta>.kommo.com` se o padrão não responder |
| `DIAS` | 90 | janela de análise |
| `HORARIO` | `8-18` | horário comercial (seg a sex, fuso da conta) |
| `SAIDA` | `auditoria/saida` | pasta de saída |

Atrás de proxy HTTP: `NODE_USE_ENV_PROXY=1`.

## Saída

- `saida/metricas.json`: números agregados, base dos relatórios. Pode ser compartilhado.
- `saida/resumo.md`: leitura rápida.
- `saida/bruto/`: respostas cruas da API. Tem nome, telefone e histórico de lead: não vai pro git (`.gitignore`).

O token nunca é gravado pelo script. Não commite o token.

# Revisão de vídeo

API para revisar entregas de criadores. Cada entrega tem peças (`script`, `video`, `cover`, `caption`), cada peça tem versões, e cada versão recebe comentários ancorados em um segundo. A campanha declara quais peças são obrigatórias, e a entrega só pode ser aprovada quando a versão atual de cada peça obrigatória estiver aprovada.

Stack: Node 22+, TypeScript estrito, Fastify 5, Zod 4, Vitest. Persistência em memória.

## Como rodar

```bash
npm install
npm test          # 25 testes (domínio + HTTP via fastify.inject)
npm run typecheck
npm start         # http://localhost:3000 (PORT para trocar)
```

## Endpoints

| Método | Rota | O que faz |
| --- | --- | --- |
| POST | `/campaigns` | cria campanha `{ name, requiredPieces }` |
| GET | `/campaigns/:campaignId` | lê campanha |
| POST | `/campaigns/:campaignId/deliveries` | cria entrega `{ creator }` |
| GET | `/deliveries/:deliveryId` | entrega com status, peças, versão atual, bloqueios e histórico |
| POST | `/deliveries/:deliveryId/pieces/:kind/versions` | envia nova versão `{ content, submittedBy, durationSeconds? }` |
| GET | `/deliveries/:deliveryId/pieces/:kind/versions` | lista versões da peça |
| GET | `/versions/:versionId` | lê versão |
| POST | `/versions/:versionId/review` | `{ decision: "APPROVE" \| "REQUEST_CHANGES", reviewer, note? }` |
| POST | `/versions/:versionId/comments` | `{ second, author, text }` |
| GET | `/versions/:versionId/comments` | comentários daquela versão, ordenados pelo segundo |
| POST | `/deliveries/:deliveryId/approve` | `{ approver }` |

## Exemplos

Criar campanha:

```http
POST /campaigns
{ "name": "Lançamento verão", "requiredPieces": ["script", "video"] }

201
{ "id": "cmp_a05c…", "name": "Lançamento verão", "requiredPieces": ["script", "video"], "createdAt": "2026-10-10T06:31:12.572Z" }
```

Enviar versão de vídeo e comentar no segundo 12:

```http
POST /deliveries/dlv_c6ef…/pieces/video/versions
{ "content": "https://cdn.example.com/v1.mp4", "durationSeconds": 30, "submittedBy": "ana" }

201
{ "id": "ver_5541…", "deliveryId": "dlv_c6ef…", "pieceKind": "video", "number": 1, "content": "https://cdn.example.com/v1.mp4",
  "durationSeconds": 30, "submittedBy": "ana", "submittedAt": "…", "status": "PENDING_REVIEW", "review": null }

POST /versions/ver_5541…/comments
{ "second": 12, "author": "marca", "text": "Produto aparece tarde" }

201
{ "id": "cmt_04c3…", "versionId": "ver_5541…", "second": 12, "author": "marca", "text": "Produto aparece tarde", "createdAt": "…" }
```

Tentar aprovar antes da hora:

```http
POST /deliveries/dlv_c6ef…/approve
{ "approver": "marca" }

409
{
  "error": {
    "code": "DELIVERY_NOT_APPROVABLE",
    "message": "Delivery cannot be approved: required piece \"script\" has no version; required piece \"video\" current version 1 is pending review",
    "details": {
      "blockers": [
        { "pieceKind": "script", "reason": "MISSING_PIECE", "currentVersion": null },
        { "pieceKind": "video", "reason": "CURRENT_VERSION_PENDING_REVIEW", "currentVersion": 1 }
      ]
    }
  }
}
```

Depois de uma nova versão numa entrega aprovada, `GET /deliveries/:id` volta com `"status": "IN_REVIEW"`, `"approval": null` e um evento no histórico:

```json
{ "type": "APPROVAL_REVOKED", "at": "2026-05-10T10:00:00.000Z", "reason": "NEW_VERSION_SUBMITTED", "pieceKind": "video", "versionId": "ver_4b1e…" }
```

Todos os erros seguem o formato `{ "error": { "code", "message", "details" } }`:

| Código | HTTP | Quando |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | payload ou parâmetro inválido (tipo de peça desconhecido, segundo negativo, peças repetidas) |
| `BAD_REQUEST` | 400 | JSON malformado |
| `NOT_FOUND` | 404 | campanha, entrega, versão ou rota inexistente |
| `DURATION_REQUIRED` | 422 | versão de vídeo sem `durationSeconds` |
| `COMMENT_OUT_OF_RANGE` | 422 | comentário num segundo além da duração da versão |
| `VERSION_NOT_CURRENT` | 409 | revisão de uma versão já substituída |
| `DELIVERY_NOT_APPROVABLE` | 409 | alguma peça obrigatória sem versão atual aprovada (lista os bloqueios) |
| `DELIVERY_ALREADY_APPROVED` | 409 | aprovar entrega já aprovada |

## Decisões

- **Peças obrigatórias são dados.** A campanha guarda `requiredPieces` e a aprovação percorre essa lista. Não existe `if (kind === "video")` na regra de aprovação. O que muda por tipo de peça (só o vídeo exige duração) fica em `PIECE_CATALOG`.
- **Versão atual é a de maior número.** Status da versão: `PENDING_REVIEW`, `APPROVED` ou `CHANGES_REQUESTED`. Só a versão atual pode ser revisada: aprovar uma versão antiga não faz sentido e devolve `VERSION_NOT_CURRENT`.
- **Comentários pertencem à versão.** O comentário guarda `versionId` e `second`. Uma versão nova começa sem comentários; os antigos continuam visíveis na versão onde foram feitos. Comentar numa versão antiga é permitido (o comentário fica nela). O segundo é obrigatório em qualquer peça e, quando a versão tem duração, precisa estar dentro dela.
- **Peça não obrigatória não bloqueia.** Pode estar pendente ou com ajustes pedidos que a entrega continua aprovável. Ela aparece em `pieces` com `required: false`.
- **Revogação.** Qualquer versão nova numa entrega aprovada revoga a aprovação, inclusive de peça não obrigatória, porque o conteúdo aprovado mudou. Pedir ajustes na versão atual de uma entrega aprovada também revoga. A entrega fica `IN_REVIEW` até alguém chamar `/approve` de novo, e essa chamada passa pela mesma checagem de bloqueios. Comentários e reaprovações idempotentes não revogam. Cada aprovação e revogação fica em `history`.
- **Revisar de novo com a mesma decisão** é idempotente (não altera revisor nem horário).
- **Relógio controlável.** `ReviewService` e `buildApp` recebem um `Clock`. Os testes usam `ManualClock` (`set`/`advance`) e um gerador de ids sequencial para checar timestamps e ids exatos.

## O que ficou de fora

- Persistência real (o `InMemoryStore` some quando o processo reinicia), concorrência e paginação.
- Autenticação e papéis: `reviewer`, `approver` e `author` são strings informadas pelo cliente.
- Upload de arquivos: `content` é uma URL ou texto.
- Editar ou apagar comentários, threads e resolução de comentários.
- Alterar `requiredPieces` de uma campanha que já tem entregas.

## Uso de IA

Código gerado com assistência de IA (Claude Code). O que a IA fez:

- Modelou o domínio (campanha, entrega, peça, versão, comentário, bloqueios, histórico de aprovação).
- Escreveu o `ReviewService`, a API Fastify com validação Zod e o tratamento de erros.
- Escreveu os testes de domínio e de HTTP com relógio controlável.
- Configurou o projeto (TypeScript estrito, Vitest, scripts npm) e escreveu este README.

Revisao humana: [Rodrigo completa]

# VitalHelp

## Arquitetura

- **Frontend:** HTML, JavaScript e Tailwind CSS em `frontEnd/`.
- **Backend:** TypeScript, Node.js e Express. `backEnd/server.ts` expõe os endpoints HTTP, `backEnd/services/` contém regras de negócio, e `backEnd/repositories/database.ts` concentra o acesso ao MySQL.
- **Persistência:** MySQL 8.4/InnoDB com migração SQL versionada em `backEnd/migrations/001_initial_schema.sql`. A API aplica a migração inicial ao iniciar.
- **Autenticação:** login por e-mail/senha ou Google OpenID Connect; sessões opacas em cookies HttpOnly de duas horas. Só o hash SHA-256 do token é persistido, e logout remove a sessão.

O modelo relacional contém `users`, `medical_profiles`, `emergency_contacts`, `password_reset_tokens` e `auth_sessions`, com chaves estrangeiras, unicidade de perfil/contato e exclusão em cascata. `name` em `users` facilita a experiência de cadastro; `date_of_birth` em `medical_profiles` é necessário para o formulário atual. As senhas da conta e de consulta usam Argon2id; dados clínicos são criptografados com AES-256-GCM antes de serem armazenados nos campos clínicos. O token do QR identifica o perfil, mas não contém dados médicos. A sessão pública registra a versão do acesso e é invalidada ao editar o perfil ou trocar a senha de consulta.

## Executar localmente

1. Copie `.env.example` para `.env` se ainda não existir. Preserve `GOOGLE_CLIENT_ID` e `SESSION_SECRET` já configurados; use senhas locais fortes e diferentes para `MYSQL_PASSWORD` e `MYSQL_ROOT_PASSWORD`.
2. Configure `MYSQL_DATABASE=vitalhelp_v2` para usar o banco novo. Não aponte esta versão para o banco antigo: o modelo mudou e os dados existentes não são migrados. Os arquivos SQLite antigos permanecem intactos.
3. No Google Cloud Console, configure a tela de consentimento OAuth e crie um OAuth Client ID do tipo **Aplicativo da Web**.
4. No OAuth Client ID, adicione `http://127.0.0.1:5173` e `http://localhost:5173` em **Origens JavaScript autorizadas** e configure `GOOGLE_CLIENT_ID` no `.env`. São origens diferentes: abra o app usando exatamente uma delas, incluindo a porta `5173`.
5. Gere `SESSION_SECRET` com `openssl rand -base64 32`. Não compartilhe esse segredo.
6. Inicie o MySQL com `docker compose up -d mysql` e aguarde até `docker compose ps` indicar que está saudável.
7. Execute `npm run dev` na raiz e abra `http://127.0.0.1:5173`. A API TypeScript é executada em modo watch. Para validar o frontend e compilar a API, use `npm run build`.

Para consultar pelo celular durante o desenvolvimento, conecte o celular e o computador à mesma rede Wi-Fi e permita conexões nas portas 5173 e 3000 no firewall. Se a detecção automática escolher o IP incorreto, configure `PUBLIC_FRONTEND_URL` no `.env`, por exemplo `http://192.168.1.25:5173`, e reinicie o servidor.

## API utilizada pelo frontend

- `GET /api/config`
- `POST /api/auth/signup`, `POST /api/auth/login` e `POST /api/auth/google`
- `GET /api/me`, `POST /api/logout` e `DELETE /api/account`
- `GET /api/profile` e `PUT /api/profile`
- `POST /api/consultation-password/generate` e `GET /api/qr`
- `POST /api/public/:publicId/unlock` e `GET /api/public/:publicId/profile`
- `POST /api/public/logout`

A consulta pública exige a senha de consulta e é somente leitura. A autenticação cria uma sessão pública opaca de duas horas, separada da sessão da conta. O código QR só é liberado quando o perfil está completo e a senha de consulta foi configurada.

## Testes e implantação

Execute `npm test` com o MySQL local rodando e `MYSQL_ROOT_PASSWORD` definido no `.env`. Os testes criam e removem um banco temporário, bloqueiam hosts que não sejam loopback e nunca devem ser executados contra produção. O teste cobre cadastro, sessão, perfil, geração/rotação do código de consulta, leitura pública e exclusão da conta.

Para iniciar a aplicação empacotada, execute `docker compose up -d --build app` e abra `http://127.0.0.1:3000`. O Compose usa o volume novo `vitalhelp_mysql_v2`; qualquer volume da versão anterior permanece intacto.

## Limites importantes

Esta implementação é para desenvolvimento e demonstração, não para armazenar dados reais de saúde nem publicar em produção sem revisão. Antes de usar dados reais, faça uma revisão de segurança e LGPD, configure HTTPS, gerenciamento/backup de chaves, controles de acesso, monitoramento e recuperação de dados. O reset de senha e o envio transacional de e-mail ainda não estão implementados; a tabela `password_reset_tokens` já está prevista no modelo para essa evolução. Os handlers HTTP ainda ficam concentrados em `backEnd/server.ts`; separar rotas/controllers é a próxima melhoria arquitetural para completar as camadas propostas.

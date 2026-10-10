# 🚗🔧 Manutenção de Veículos

App (PWA) para controlar manutenções, revisões e custos dos veículos da família.
Funciona no navegador e pode ser **instalado no celular como aplicativo**.

## Funcionalidades

- **Vários veículos** — carros, motos e caminhões, com marca/modelo/ano escolhidos pela **Tabela FIPE** (e o valor FIPE do veículo)
- **Histórico de serviços** — data, km, categoria, oficina, valor e observações
- **Plano de manutenção com alertas** — itens por km e/ou tempo (ex.: óleo a cada 10.000 km ou 12 meses); avisa o que está *vencido* ou *em breve*. Ao cadastrar um veículo, um plano padrão pode ser criado automaticamente
- **Relatórios de custos** — total por mês/ano, por categoria e por veículo, custo por km e exportação CSV
- **Compartilhamento com a família** — cada pessoa tem seu login; uma *garagem* reúne os veículos e é compartilhada por um código de convite
- Atualização automática do km do veículo ao registrar um serviço

## Tecnologias

- HTML, CSS e JavaScript puros (sem build) — hospedado no **GitHub Pages**
- **Supabase** (Postgres + autenticação) — dados protegidos por Row Level Security
- [API FIPE](https://deividfortuna.github.io/fipe/v2/) (fipe.parallelum.com.br) para marcas, modelos e valores

## Como configurar

### 1. Banco de dados (Supabase — plano gratuito)

1. Crie uma conta em <https://supabase.com> e um novo projeto.
2. Abra **SQL Editor → New query**, cole o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Em **Project Settings → API**, copie a **Project URL** e a chave **anon / publishable**.
4. Cole os dois valores em [`js/config.js`](js/config.js).

> A chave *anon* é pública por design: ela só permite o que as políticas RLS do `schema.sql` liberam
> (cada usuário vê apenas as garagens das quais é membro). **Nunca** use a chave `service_role` no app.

### 2. Publicar no GitHub Pages

1. Faça push do projeto para o GitHub.
2. Em **Settings → Pages**, selecione *Deploy from a branch*, branch `main`, pasta `/ (root)`.
3. O app ficará em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

### 3. Ajustar a autenticação no Supabase

Em **Authentication → URL Configuration**:

- **Site URL**: a URL do GitHub Pages (ex.: `https://seu-usuario.github.io/manutencao-veiculos/`)
- **Redirect URLs**: a mesma URL (e `http://localhost:8080/` se for testar localmente)

Isso faz os links de confirmação de e-mail e de redefinição de senha voltarem para o app.

### 4. Instalar no celular

- **Android (Chrome)**: abra o site → menu ⋮ → *Instalar app* / *Adicionar à tela inicial*
- **iPhone (Safari)**: abra o site → botão Compartilhar → *Adicionar à Tela de Início*

#### Detalhes do iPhone (iOS 16.4 ou mais recente recomendado)

- No iPhone o app é instalado pelo **Safari** (o próprio app mostra um aviso explicando como). Depois de
  instalado, abre em tela cheia, com ícone próprio, sem barra do navegador.
- O app instalado guarda o login **separado do Safari**. Por isso o link de confirmação de cadastro
  (que abre no Safari) não deixa o app logado: depois de confirmar o e-mail, volte ao app e entre com e-mail e senha.
- A busca de marca/modelo/ano usa uma lista própria (o `<datalist>` padrão no iPhone só mostra sugestões
  acima do teclado). Palavras como "turbo", "automático" e "manual" também encontram as abreviações da FIPE.
- *Exportar CSV* abre o menu **Compartilhar** do iOS (salvar em Arquivos, enviar por WhatsApp, e-mail…).
- Não é preciso App Store. Um app nativo na App Store exigiria Mac com Xcode e a conta Apple Developer (US$ 99/ano).

### 5. Convidar a família

Na aba **Garagem**, toque em *Compartilhar* para enviar o código de convite. A pessoa cria uma conta
e escolhe *Recebeu um código?* na primeira tela (ou *Entrar em outra garagem* depois).

## Rodar localmente

Qualquer servidor estático serve, por exemplo:

```bash
python -m http.server 8080
```

e abra <http://localhost:8080>.

## Estrutura

```
index.html            página única do app
css/style.css         estilos (tema claro/escuro, layout mobile)
js/config.js          URL e chave do Supabase
js/app.js             telas, formulários e regras
js/util.js            datas, formatação, planos padrão e cálculo de vencimento
js/fipe.js            cliente da API FIPE (com cache)
js/db.js              cliente Supabase
sw.js                 service worker (instalação/offline)
manifest.webmanifest  manifesto do PWA
supabase/schema.sql   tabelas, funções e políticas de segurança
```

## Ideias para próximas versões

- Notificações push de revisões vencendo
- Anexar fotos de notas fiscais (Supabase Storage)
- Registro de abastecimentos e consumo médio
- Estimativa da data do próximo serviço pela média de km rodados

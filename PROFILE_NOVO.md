# Atualização de perfil LoveMix

Esta atualização adiciona:
- Data de nascimento editável e idade calculada no perfil público.
- Campo de gênero com ícones/símbolos.
- Publicação de fotos na galeria do perfil.
- Visibilidade por publicação: público, amigos (match) ou privado.
- Upload comprimido para reduzir consumo de dados em celulares simples.

## Publicação das regras Firebase
Antes de testar, publique as regras atualizadas:
- Firestore: `firestore.rules`
- Storage: `storage.rules`

As fotos de amigos usam os documentos `matches/{uid1_uid2}` criados pelo fluxo de match existente. A leitura do perfil segue a visibilidade definida: público para pessoas autenticadas, amigos somente para quem tem match e privado somente para o próprio titular e administradores. A seleção de visibilidade das publicações da galeria também é aplicada pelas regras do Firestore. O e-mail não é armazenado no documento público do perfil. URLs de download do Firebase Storage são links portadores: quem obtiver e compartilhar uma URL poderá acessá-la. Para privacidade forte de mídia, migre a entrega das imagens para URLs autenticadas/temporárias via backend.

A compilação e os testes no Firebase real ainda precisam ser executados no GitHub Actions com as credenciais do projeto.

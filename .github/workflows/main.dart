import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:gamepads/gamepads.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  GamepadMonitor.instance.start();
  runApp(const ClouddroidApp());
}

const purple = Color(0xFF9B5CFF);
const background = Color(0xFF090811);

const panel = Color(0xFF171322);

/// Monitora os controles desde a inicialização do app, sem exigir que o
/// usuário abra a tela de controles. O Android entrega eventos quando um
/// gamepad Bluetooth/USB é conectado ou desconectado enquanto o app está ativo.
class GamepadMonitor {
  GamepadMonitor._();
  static final GamepadMonitor instance = GamepadMonitor._();

  final ValueNotifier<List<GamepadController>> controllers =
      ValueNotifier<List<GamepadController>>(<GamepadController>[]);
  StreamSubscription<GamepadConnectionEvent>? _connectionSubscription;
  bool _started = false;
  bool _refreshing = false;

  void start() {
    if (_started) return;
    _started = true;
    _connectionSubscription = Gamepads.connectionEvents.listen((_) {
      refresh();
    });
    refresh();
  }

  Future<void> refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      final found = await Gamepads.list();
      controllers.value = found;
    } catch (_) {
      // Mantém o último estado conhecido se o Android não responder.
    } finally {
      _refreshing = false;
    }
  }
}

/// O Android já entrega os eventos de mouse Bluetooth/USB ao Flutter.
/// Registramos esses eventos globalmente para indicar quando o mouse está ativo.
class MouseMonitor {
  MouseMonitor._();
  static final MouseMonitor instance = MouseMonitor._();

  final ValueNotifier<bool> active = ValueNotifier<bool>(false);
  final ValueNotifier<String> lastAction = ValueNotifier<String>('Aguardando mouse');
  Timer? _idleTimer;

  void handle(PointerEvent event) {
    if (event.kind != ui.PointerDeviceKind.mouse) return;
    active.value = true;
    if (event is PointerDownEvent) {
      lastAction.value = event.buttons == 2 ? 'Clique direito' : 'Clique do mouse';
    } else if (event is PointerHoverEvent || event is PointerMoveEvent) {
      lastAction.value = 'Movimento do mouse';
    } else if (event is PointerScrollEvent) {
      lastAction.value = 'Roda de rolagem';
    } else if (event is PointerUpEvent) {
      lastAction.value = 'Botão liberado';
    }
    _idleTimer?.cancel();
    _idleTimer = Timer(const Duration(seconds: 15), () {
      active.value = false;
    });
  }
}

class ClouddroidApp extends StatelessWidget {
  const ClouddroidApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Clouddroid Gaming',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: background,
        colorScheme: ColorScheme.fromSeed(
          seedColor: purple,
          brightness: Brightness.dark,
          surface: panel,
        ),
        useMaterial3: true,
        fontFamily: 'Roboto',
      ),
      builder: (context, child) => Listener(
        behavior: HitTestBehavior.translucent,
        onPointerHover: MouseMonitor.instance.handle,
        onPointerMove: MouseMonitor.instance.handle,
        onPointerDown: MouseMonitor.instance.handle,
        onPointerUp: MouseMonitor.instance.handle,
        onPointerSignal: MouseMonitor.instance.handle,
        child: child ?? const SizedBox.shrink(),
      ),
      home: const HomeScreen(),
    );
  }
}

class Game {
  final String title;
  final String category;
  final String platform;
  const Game(this.title, this.category, this.platform);
}

const games = <Game>[
  Game('Grand Theft Auto V', 'Ação e mundo aberto', 'PC / Console'),
  Game('Grand Theft Auto VI', 'Ação e mundo aberto', 'A confirmar'),
  Game('Free Fire', 'Battle royale', 'Android'),
  Game('The Last of Us Part I', 'Ação e aventura', 'PC / Console'),
  Game('The Last of Us Part II', 'Ação e aventura', 'Console'),
  Game('Resident Evil 0', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil 2 Remake', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil 3 Remake', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil 4 Remake', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil 5', 'Terror e ação', 'PC / Console'),
  Game('Resident Evil 6', 'Terror e ação', 'PC / Console'),
  Game('Resident Evil 7', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil Village', 'Terror e sobrevivência', 'PC / Console'),
  Game('Resident Evil Requiem', 'Terror e sobrevivência', 'A confirmar'),
  Game('Red Dead Redemption 2', 'Ação e mundo aberto', 'PC / Console'),
  Game('God of War Ragnarök', 'Ação e aventura', 'PC / Console'),
  Game('Spider-Man: Miles Morales', 'Ação e aventura', 'PC / Console'),
  Game('Elden Ring', 'RPG e ação', 'PC / Console'),
  Game('Cyberpunk 2077', 'RPG e mundo aberto', 'PC / Console'),
  Game('Hogwarts Legacy', 'Aventura', 'PC / Console'),
  Game('Call of Duty', 'Tiro', 'PC / Console'),
  Game('PUBG', 'Battle royale', 'PC / Console / Mobile'),
  Game('Dying Light 2', 'Ação e sobrevivência', 'PC / Console'),
  Game('Days Gone', 'Ação e sobrevivência', 'PC / Console'),
  Game('Forza Horizon 5', 'Corrida', 'PC / Console'),
  Game('Need for Speed', 'Corrida', 'PC / Console'),
  Game('EA Sports FC', 'Esportes', 'PC / Console'),
  Game('F1', 'Corrida', 'PC / Console'),
  Game('Minecraft', 'Sandbox', 'PC / Console / Mobile'),
  Game('The Sims 4', 'Simulação', 'PC / Console'),
  Game('Terraria', 'Aventura e sandbox', 'PC / Console / Mobile'),
  Game('Mortal Kombat 1', 'Luta', 'PC / Console'),
  Game('Tekken 8', 'Luta', 'PC / Console'),
  Game('Street Fighter 6', 'Luta', 'PC / Console'),
  Game('Assassin’s Creed Shadows', 'Ação e aventura', 'PC / Console'),
];

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int tab = 0;
  String query = '';
  String category = 'Todos';

  List<String> get categories => ['Todos', ...{
    for (final game in games) game.category
  }.toList()..sort()];

  @override
  Widget build(BuildContext context) {
    final filtered = games.where((g) {
      final matchesQuery = g.title.toLowerCase().contains(query.toLowerCase());
      final matchesCategory = category == 'Todos' || g.category == category;
      return matchesQuery && matchesCategory;
    }).toList();

    return Scaffold(
      appBar: AppBar(
        backgroundColor: background,
        title: const Row(
          children: [
            Icon(Icons.cloud_outlined, color: purple, size: 30),
            SizedBox(width: 9),
            Text('CLOUDDROID', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.2)),
          ],
        ),
        actions: [
          ValueListenableBuilder<List<GamepadController>>(
            valueListenable: GamepadMonitor.instance.controllers,
            builder: (context, controllers, _) => IconButton(
              tooltip: controllers.isEmpty ? 'Nenhum controle conectado' : 'Controle conectado automaticamente',
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const GamepadScreen())),
              icon: Icon(Icons.gamepad_outlined, color: controllers.isEmpty ? null : Colors.greenAccent),
            ),
          ),
          ValueListenableBuilder<bool>(
            valueListenable: MouseMonitor.instance.active,
            builder: (context, active, _) => IconButton(
              tooltip: active ? 'Mouse ativo' : 'Mouse aguardando movimento',
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const MouseScreen())),
              icon: Icon(Icons.mouse_outlined, color: active ? Colors.greenAccent : null),
            ),
          ),
          IconButton(
            tooltip: 'Perfil',
            onPressed: () => _info('Perfil', 'A área de conta será conectada ao serviço de autenticação na próxima etapa.'),
            icon: const Icon(Icons.account_circle_outlined),
          ),
        ],
      ),
      body: tab == 0
          ? _catalog(filtered)
          : tab == 1
              ? const TranslatorScreen()
              : const AccountScreen(),
      bottomNavigationBar: NavigationBar(
        backgroundColor: panel,
        indicatorColor: purple.withValues(alpha: .22),
        selectedIndex: tab,
        onDestinationSelected: (v) => setState(() => tab = v),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.sports_esports_outlined), selectedIcon: Icon(Icons.sports_esports), label: 'Jogos'),
          NavigationDestination(icon: Icon(Icons.translate), label: 'Tradutor'),
          NavigationDestination(icon: Icon(Icons.person_outline), label: 'Conta'),
        ],
      ),
    );
  }

  Widget _catalog(List<Game> filtered) {
    return CustomScrollView(
      slivers: [
        SliverToBoxAdapter(
          child: ValueListenableBuilder<List<GamepadController>>(
            valueListenable: GamepadMonitor.instance.controllers,
            builder: (context, controllers, _) {
              final connected = controllers.isNotEmpty;
              return Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Container(
                  padding: const EdgeInsets.all(13),
                  decoration: BoxDecoration(
                    color: connected ? const Color(0xFF123324) : panel,
                    borderRadius: BorderRadius.circular(15),
                    border: Border.all(color: connected ? Colors.greenAccent.withValues(alpha: .45) : Colors.white12),
                  ),
                  child: Row(children: [
                    Icon(connected ? Icons.gamepad : Icons.bluetooth_searching,
                        color: connected ? Colors.greenAccent : Colors.white60),
                    const SizedBox(width: 10),
                    Expanded(child: Text(
                      connected
                          ? 'Controle conectado automaticamente${controllers.length > 1 ? ' (${controllers.length})' : ''}'
                          : 'Conecte seu controle no Bluetooth do celular. O app detectará automaticamente.',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
                    )),
                    if (connected) const Icon(Icons.check_circle, color: Colors.greenAccent, size: 18),
                  ]),
                ),
              );
            },
          ),
        ),
        SliverToBoxAdapter(
          child: ValueListenableBuilder<bool>(
            valueListenable: MouseMonitor.instance.active,
            builder: (context, active, _) => Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: active ? const Color(0xFF123324) : panel,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: active ? Colors.greenAccent.withValues(alpha: .4) : Colors.white12),
                ),
                child: Row(children: [
                  Icon(Icons.mouse, color: active ? Colors.greenAccent : Colors.white60),
                  const SizedBox(width: 10),
                  Expanded(child: Text(
                    active ? 'Mouse reconhecido e ativo' : 'Mouse Bluetooth ou USB: conecte ao celular e mova ou clique para usar',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                  )),
                  if (active) const Icon(Icons.check_circle, color: Colors.greenAccent, size: 18),
                ]),
              ),
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(24),
                gradient: const LinearGradient(
                  colors: [Color(0xFF38205E), Color(0xFF171126), Color(0xFF10101A)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                border: Border.all(color: purple.withValues(alpha: .45)),
              ),
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('SEU PRÓXIMO JOGO COMEÇA AQUI', style: TextStyle(color: Color(0xFFD9C4FF), fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.bold)),
                  SizedBox(height: 10),
                  Text('Jogue na nuvem.', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w900)),
                  SizedBox(height: 5),
                  Text('Um catálogo para acessar pelo celular. O streaming será ativado quando um servidor compatível estiver conectado.', style: TextStyle(color: Colors.white70, height: 1.35)),
                  SizedBox(height: 14),
                  Row(children: [Icon(Icons.cloud_queue, color: purple), SizedBox(width: 7), Text('Plataforma em construção', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700))]),
                ],
              ),
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
            child: TextField(
              onChanged: (v) => setState(() => query = v),
              decoration: InputDecoration(
                hintText: 'Buscar jogo...',
                prefixIcon: const Icon(Icons.search),
                filled: true,
                fillColor: panel,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
              ),
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: SizedBox(
            height: 45,
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              scrollDirection: Axis.horizontal,
              children: categories.map((c) => Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: ChoiceChip(
                  label: Text(c),
                  selected: category == c,
                  onSelected: (_) => setState(() => category = c),
                  selectedColor: purple.withValues(alpha: .35),
                ),
              )).toList(),
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          sliver: SliverGrid(
            delegate: SliverChildBuilderDelegate(
              (context, index) {
                final game = filtered[index];
                return InkWell(
                  borderRadius: BorderRadius.circular(18),
                  onTap: () => _gameInfo(game),
                  child: Container(
                    padding: const EdgeInsets.all(13),
                    decoration: BoxDecoration(
                      color: panel,
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: Colors.white.withValues(alpha: .07)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          height: 43,
                          width: 43,
                          decoration: BoxDecoration(color: purple.withValues(alpha: .18), borderRadius: BorderRadius.circular(13)),
                          child: const Icon(Icons.videogame_asset_rounded, color: Color(0xFFC7A4FF), size: 25),
                        ),
                        const Spacer(),
                        Text(game.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
                        const SizedBox(height: 4),
                        Text(game.category, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white60, fontSize: 11)),
                        const SizedBox(height: 9),
                        const Row(children: [
                          Icon(Icons.lock_clock_outlined, color: Colors.orangeAccent, size: 14),
                          SizedBox(width: 4),
                          Expanded(child: Text('Aguardando servidor', style: TextStyle(color: Colors.orangeAccent, fontSize: 10, fontWeight: FontWeight.w600))),
                        ]),
                      ],
                    ),
                  ),
                );
              },
              childCount: filtered.length,
            ),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 1.18,
            ),
          ),
        ),
      ],
    );
  }

  void _gameInfo(Game game) {
    showModalBottomSheet(
      context: context,
      backgroundColor: panel,
      showDragHandle: true,
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(22, 8, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(game.title, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Text('${game.category} • ${game.platform}', style: const TextStyle(color: Colors.white60)),
            const SizedBox(height: 15),
            const Text('Este título está no catálogo planejado. Para jogar, ainda é necessário conectar um provedor de cloud gaming, verificar a compatibilidade e garantir a licença/cópia do jogo.'),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.notifications_active_outlined),
              label: const Text('Entendi'),
            ),
          ],
        ),
      ),
    );
  }

  void _info(String title, String message) {
    showDialog(context: context, builder: (_) => AlertDialog(
      backgroundColor: panel,
      title: Text(title),
      content: Text(message),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Fechar'))],
    ));
  }
}


class MouseScreen extends StatelessWidget {
  const MouseScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Mouse Bluetooth / USB')),
    body: ListView(padding: const EdgeInsets.all(18), children: [
      ValueListenableBuilder<bool>(
        valueListenable: MouseMonitor.instance.active,
        builder: (context, active, _) => Card(
          color: panel,
          child: Padding(padding: const EdgeInsets.all(18), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(Icons.mouse, size: 34, color: active ? Colors.greenAccent : purple),
              const SizedBox(width: 12),
              Expanded(child: Text(active ? 'Mouse reconhecido' : 'Aguardando movimento do mouse', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold))),
            ]),
            const SizedBox(height: 12),
            Text(active ? 'O Clouddroid está recebendo os movimentos e cliques.' : 'Conecte o mouse nas configurações Bluetooth do Android ou por USB. Depois mova o mouse ou clique na tela.', style: const TextStyle(color: Colors.white70, height: 1.4)),
          ])),
        ),
      ),
      const SizedBox(height: 14),
      const Text('ÚLTIMA AÇÃO DETECTADA', style: TextStyle(color: Color(0xFFC7A4FF), fontWeight: FontWeight.bold, letterSpacing: 1)),
      const SizedBox(height: 8),
      ValueListenableBuilder<String>(
        valueListenable: MouseMonitor.instance.lastAction,
        builder: (context, action, _) => Card(color: panel, child: Padding(padding: const EdgeInsets.all(16), child: Text(action, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)))),
      ),
      const SizedBox(height: 14),
      const Text('O cursor, os cliques esquerdo/direito e a roda de rolagem são recebidos pelo Android e pelo Flutter automaticamente. Para controlar um jogo transmitido, o serviço de streaming também precisa encaminhar os comandos do mouse.', style: TextStyle(color: Colors.white60, height: 1.45)),
    ]),
  );
}

class GamepadScreen extends StatefulWidget {
  const GamepadScreen({super.key});

  @override
  State<GamepadScreen> createState() => _GamepadScreenState();
}

class _GamepadScreenState extends State<GamepadScreen> {
  List<GamepadController> _controllers = [];
  StreamSubscription<GamepadConnectionEvent>? _connectionSub;
  StreamSubscription<NormalizedGamepadEvent>? _inputSub;
  String _lastInput = 'Aguardando comando do controle';
  String _lastValue = '—';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refreshControllers();
    GamepadMonitor.instance.refresh();
    _connectionSub = Gamepads.connectionEvents.listen((_) => _refreshControllers());
    _inputSub = Gamepads.normalizedEvents.listen((event) {
      if (!mounted) return;
      final control = event.button?.name ?? event.axis?.name ?? 'Entrada';
      setState(() {
        _lastInput = control;
        _lastValue = event.value.toStringAsFixed(2);
      });
    });
  }

  Future<void> _refreshControllers() async {
    try {
      final found = await Gamepads.list();
      if (!mounted) return;
      setState(() {
        _controllers = found;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _connectionSub?.cancel();
    _inputSub?.cancel();
    for (final controller in _controllers) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Controle Bluetooth')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: panel,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: purple.withValues(alpha: .45)),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Icon(Icons.gamepad_rounded, color: purple, size: 32),
                const SizedBox(width: 10),
                const Expanded(child: Text('Controles compatíveis', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w900))),
              ]),
              const SizedBox(height: 10),
              const Text('O Clouddroid detecta controles Bluetooth ou USB reconhecidos pelo Android, incluindo modelos compatíveis com Xbox, PlayStation e controles genéricos.', style: TextStyle(color: Colors.white70, height: 1.4)),
              const SizedBox(height: 14),
              FilledButton.icon(
                onPressed: () async {
                  await _refreshControllers();
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Lista de controles atualizada. Para parear, use as configurações Bluetooth do Android.')));
                },
                icon: const Icon(Icons.refresh),
                label: const Text('Procurar controles conectados'),
              ),
            ]),
          ),
          const SizedBox(height: 20),
          const Text('DISPOSITIVOS', style: TextStyle(color: Color(0xFFC7A4FF), fontWeight: FontWeight.bold, letterSpacing: 1.1)),
          const SizedBox(height: 8),
          if (_loading)
            const Center(child: Padding(padding: EdgeInsets.all(20), child: CircularProgressIndicator()))
          else if (_controllers.isEmpty)
            Card(color: panel, child: const Padding(
              padding: EdgeInsets.all(16),
              child: Row(children: [Icon(Icons.bluetooth_disabled, color: Colors.white54), SizedBox(width: 12), Expanded(child: Text('Nenhum controle detectado. Conecte ou pareie um controle no Bluetooth do celular e toque em Procurar.'))]),
            ))
          else
            ..._controllers.map((controller) => Card(
              color: panel,
              child: ListTile(
                leading: const CircleAvatar(backgroundColor: Color(0xFF38205E), child: Icon(Icons.sports_esports, color: Color(0xFFC7A4FF))),
                title: Text(controller.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                subtitle: Text('Conectado • ID ${controller.id}'),
                trailing: const Icon(Icons.check_circle, color: Colors.greenAccent),
              ),
            )),
          const SizedBox(height: 20),
          const Text('TESTE DE BOTÕES E ANALÓGICOS', style: TextStyle(color: Color(0xFFC7A4FF), fontWeight: FontWeight.bold, letterSpacing: 1.1)),
          const SizedBox(height: 8),
          Card(color: panel, child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_lastInput, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              Text('Valor: $_lastValue', style: const TextStyle(color: Colors.white60)),
              const SizedBox(height: 8),
              const Text('Pressione um botão ou mova um analógico para testar a leitura.', style: TextStyle(color: Colors.white60)),
            ]),
          )),
          const SizedBox(height: 12),
          const Text('Como conectar: 1. Abra Configurações do Android → Bluetooth. 2. Coloque o controle em modo de pareamento. 3. Selecione o controle na lista do celular. 4. Volte aqui e toque em Procurar controles conectados.', style: TextStyle(color: Colors.white60, height: 1.45)),
          const SizedBox(height: 10),
          const Text('Atenção: detectar e testar o controle no aplicativo não garante que todos os jogos aceitem comandos. Isso depende do jogo e do serviço de streaming conectado.', style: TextStyle(color: Colors.orangeAccent, height: 1.4)),
        ],
      ),
    );
  }
}

class TranslatorScreen extends StatelessWidget {
  const TranslatorScreen({super.key});
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      const Icon(Icons.translate_rounded, color: purple, size: 52),
      const SizedBox(height: 14),
      const Text('Tradutor Gamer', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900)),
      const SizedBox(height: 8),
      const Text('Objetivo: ajudar a jogar em português brasileiro, inclusive quando o jogo não oferece tradução oficial.', style: TextStyle(color: Colors.white70, height: 1.4)),
      const SizedBox(height: 20),
      _feature(Icons.subtitles, 'Legendas em português', 'Depende do suporte do jogo e da fonte de legendas.'),
      _feature(Icons.menu_book_outlined, 'Menus e textos', 'Pode exigir pacote de tradução compatível.'),
      _feature(Icons.groups_outlined, 'Traduções da comunidade', 'Importar apenas arquivos permitidos pelos termos do jogo.'),
      const SizedBox(height: 18),
      Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: panel, borderRadius: BorderRadius.circular(16)),
        child: const Text('O tradutor ainda é uma área de interface. Tradução automática em tempo real requer integração técnica própria e não funciona em todos os jogos.', style: TextStyle(color: Colors.orangeAccent)),
      ),
    ],
  );

  Widget _feature(IconData icon, String title, String detail) => ListTile(
    contentPadding: EdgeInsets.zero,
    leading: CircleAvatar(backgroundColor: purple.withValues(alpha: .18), child: Icon(icon, color: purple)),
    title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
    subtitle: Text(detail, style: const TextStyle(color: Colors.white60)),
  );
}

class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key});
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: const [
      CircleAvatar(radius: 38, backgroundColor: Color(0xFF38205E), child: Icon(Icons.person, size: 42, color: Color(0xFFC7A4FF))),
      SizedBox(height: 16),
      Center(child: Text('Sua conta Clouddroid', style: TextStyle(fontSize: 23, fontWeight: FontWeight.w900))),
      SizedBox(height: 8),
      Text('O cadastro e o login serão conectados ao backend na próxima etapa.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white60)),
      SizedBox(height: 24),
      Card(color: panel, child: ListTile(leading: Icon(Icons.shield_outlined, color: purple), title: Text('Privacidade e segurança'), subtitle: Text('Configurações serão disponibilizadas na integração.'))),
      Card(color: panel, child: ListTile(leading: Icon(Icons.help_outline, color: purple), title: Text('Ajuda'), subtitle: Text('Clouddroid Gaming • versão inicial'))),
    ],
  );
}

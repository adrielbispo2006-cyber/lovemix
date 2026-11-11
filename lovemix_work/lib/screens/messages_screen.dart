import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../services/data_service.dart';
import 'chat_screen.dart';
import 'profile_view_screen.dart';

class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key});
  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  static const _bg = Color(0xFF08040D);
  static const _panel = Color(0xFF160B20);
  static const _purple = Color(0xFFB52CFF);
  static const _pink = Color(0xFFFF35C8);
  static const _gold = Color(0xFFFFD36A);
  final _search = TextEditingController();
  int _tab = 0;

  @override
  void dispose() { _search.dispose(); super.dispose(); }

  Future<void> _openPerson(String id, String name) async {
    try {
      final chatId = await DataService.instance.openDirectChat(id);
      if (!mounted) return;
      Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(chatId: chatId, otherName: name)));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Não foi possível abrir a conversa: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final service = DataService.instance;
    return Scaffold(
      backgroundColor: _bg,
      body: SafeArea(child: Column(children: [
        _header(),
        _vipTitle(),
        _onlinePeople(),
        _filters(),
        Expanded(child: _conversations()),
      ])),
    );
  }

  Widget _header() => Padding(
    padding: const EdgeInsets.fromLTRB(18, 10, 14, 8),
    child: Row(children: [
      Container(width: 42, height: 42, decoration: BoxDecoration(shape: BoxShape.circle, color: _purple.withOpacity(.15), boxShadow: [BoxShadow(color: _purple.withOpacity(.3), blurRadius: 15)]), child: const Icon(Icons.favorite, color: _pink, size: 25)),
      const SizedBox(width: 10),
      const Text('LoveMix', style: TextStyle(fontSize: 25, fontWeight: FontWeight.w900, color: Colors.white, letterSpacing: -.8)),
      const Spacer(),
      _roundAction(Icons.search, () => showDialog(context: context, builder: (ctx) => AlertDialog(backgroundColor: _panel, title: const Text('Pesquisar conversas'), content: TextField(controller: _search, autofocus: true, onChanged: (_) { if (mounted) setState(() {}); }, decoration: const InputDecoration(hintText: 'Nome da pessoa')), actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Fechar'))]))),
      _roundAction(Icons.edit_square, () => setState(() => _tab = 1)),
    ]),
  );

  Widget _roundAction(IconData icon, VoidCallback action) => Padding(
    padding: const EdgeInsets.only(left: 9),
    child: InkWell(onTap: action, borderRadius: BorderRadius.circular(30), child: Container(width: 43, height: 43, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: _purple.withOpacity(.8)), color: _panel), child: Icon(icon, color: const Color(0xFFE8B9FF), size: 22))),
  );

  Widget _vipTitle() => Container(
    width: double.infinity, padding: const EdgeInsets.symmetric(vertical: 13),
    decoration: BoxDecoration(border: Border(bottom: BorderSide(color: _gold.withOpacity(.2)), top: BorderSide(color: _purple.withOpacity(.18))), gradient: LinearGradient(colors: [_purple.withOpacity(.08), Colors.transparent, _gold.withOpacity(.04)])),
    child: const Row(mainAxisAlignment: MainAxisAlignment.center, children: [Icon(Icons.workspace_premium, color: _gold, size: 30), SizedBox(width: 10), Text('Chats VIP', style: TextStyle(color: _gold, fontSize: 24, fontFamily: 'serif', fontWeight: FontWeight.w700, shadows: [Shadow(color: _gold, blurRadius: 13)]))]),
  );

  Widget _onlinePeople() => SizedBox(
    height: 151,
    child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: FirebaseFirestore.instance.collection('users').where('isOnline', isEqualTo: true).limit(25).snapshots(),
      builder: (context, snap) {
        if (snap.hasError) return const Center(child: Text('Não foi possível carregar pessoas online.', style: TextStyle(color: Colors.white54)));
        final docs = (snap.data?.docs ?? []).where((d) => d.id != DataService.instance.uid).toList();
        if (docs.isEmpty) return const Center(child: Text('Quando alguém estiver online, aparecerá aqui.', style: TextStyle(color: Colors.white54, fontSize: 12)));
        return ListView.separated(
          padding: const EdgeInsets.fromLTRB(13, 12, 13, 8), scrollDirection: Axis.horizontal,
          itemCount: docs.length,
          separatorBuilder: (_, __) => const SizedBox(width: 13),
          itemBuilder: (context, i) {
            final d = docs[i]; final p = d.data(); final name = (p['name'] ?? 'Pessoa').toString(); final photo = (p['photoUrl'] ?? '').toString();
            return InkWell(onTap: () => _openPerson(d.id, name), child: SizedBox(width: 82, child: Column(children: [
              Stack(clipBehavior: Clip.none, children: [
                Container(padding: const EdgeInsets.all(4), decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: _gold, width: 3), boxShadow: [BoxShadow(color: _gold.withOpacity(.45), blurRadius: 12)]), child: CircleAvatar(radius: 31, backgroundColor: _panel, backgroundImage: photo.isNotEmpty ? NetworkImage(photo) : null, child: photo.isEmpty ? const Icon(Icons.person, color: Colors.white70, size: 30) : null)),
                Positioned(right: -1, bottom: 1, child: Container(width: 17, height: 17, decoration: BoxDecoration(color: const Color(0xFF20E65A), shape: BoxShape.circle, border: Border.all(color: _bg, width: 2)))),
              ]),
              const SizedBox(height: 7), Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
              Text('Online', style: TextStyle(color: Colors.greenAccent.shade400, fontSize: 10)),
            ])));
          },
        );
      },
    ),
  );

  Widget _filters() => Container(
    padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
    decoration: BoxDecoration(border: Border(top: BorderSide(color: _gold.withOpacity(.17)), bottom: BorderSide(color: _purple.withOpacity(.18)))),
    child: Row(children: [
      _filter('Todas', 0), const SizedBox(width: 7), _filter('Novos matches', 1), const SizedBox(width: 7), _filter('VIPs próximos', 2),
    ]),
  );

  Widget _filter(String label, int value) => Expanded(child: InkWell(onTap: () => setState(() => _tab = value), borderRadius: BorderRadius.circular(24), child: AnimatedContainer(duration: const Duration(milliseconds: 180), padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4), decoration: BoxDecoration(borderRadius: BorderRadius.circular(24), color: _tab == value ? _gold.withOpacity(.17) : _panel, border: Border.all(color: _tab == value ? _gold : _purple.withOpacity(.35)), boxShadow: _tab == value ? [BoxShadow(color: _gold.withOpacity(.25), blurRadius: 12)] : []), child: Text(label, textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: _tab == value ? _gold : const Color(0xFFD8C6E1), fontSize: 11, fontWeight: FontWeight.w700)))));

  Widget _conversations() => StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
    stream: DataService.instance.myChats(),
    builder: (context, snap) {
      if (snap.hasError) return const Center(child: Text('Não foi possível carregar as conversas.', style: TextStyle(color: Colors.white70)));
      if (!snap.hasData) return const Center(child: CircularProgressIndicator(color: _pink));
      final chats = [...snap.data!.docs]..sort((a, b) {
        final at = a.data()['lastMessageAt']; final bt = b.data()['lastMessageAt'];
        final am = at is Timestamp ? at.millisecondsSinceEpoch : 0; final bm = bt is Timestamp ? bt.millisecondsSinceEpoch : 0;
        return bm.compareTo(am);
      });
      if (chats.isEmpty) return _empty();
      return ListView.builder(padding: const EdgeInsets.fromLTRB(12, 12, 12, 18), itemCount: chats.length, itemBuilder: (context, i) {
        final chat = chats[i]; final data = chat.data(); final users = List<String>.from(data['users'] ?? const []);
        final other = users.firstWhere((id) => id != DataService.instance.uid, orElse: () => '');
        if (other.isEmpty) return const SizedBox.shrink();
        return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
          future: FirebaseFirestore.instance.collection('users').doc(other).get(),
          builder: (context, userSnap) {
            final p = userSnap.data?.data() ?? <String, dynamic>{};
            final name = (p['name'] ?? 'Novo match').toString(); final photo = (p['photoUrl'] ?? '').toString();
            if (_search.text.trim().isNotEmpty && !name.toLowerCase().contains(_search.text.trim().toLowerCase())) return const SizedBox.shrink();
            if (_tab == 2 && p['isVip'] != true) return const SizedBox.shrink();
            final online = p['isOnline'] == true; final vip = p['isVip'] == true; final verified = p['isVerified'] == true;
            final preview = (data['lastMessage'] ?? 'Comece uma conversa 💜').toString();
            final stamp = data['lastMessageAt'];
            final time = stamp is Timestamp ? _formatTime(stamp.toDate()) : '';
            final unreadMap = data['unreadCounts']; final unread = unreadMap is Map ? (unreadMap[DataService.instance.uid] is num ? (unreadMap[DataService.instance.uid] as num).toInt() : 0) : 0;
            return Container(margin: const EdgeInsets.only(bottom: 10), decoration: BoxDecoration(color: _panel.withOpacity(.82), borderRadius: BorderRadius.circular(25), border: Border.all(color: _purple.withOpacity(.25)), boxShadow: [BoxShadow(color: _purple.withOpacity(.07), blurRadius: 12)]), child: InkWell(borderRadius: BorderRadius.circular(25), onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(chatId: chat.id, otherName: name))), child: Padding(padding: const EdgeInsets.all(12), child: Row(children: [
              GestureDetector(onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ProfileViewScreen(userId: other))), child: Stack(clipBehavior: Clip.none, children: [Container(padding: const EdgeInsets.all(2), decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: _purple, width: 2), boxShadow: [BoxShadow(color: _pink.withOpacity(.2), blurRadius: 9)]), child: CircleAvatar(radius: 35, backgroundColor: const Color(0xFF321846), backgroundImage: photo.isNotEmpty ? NetworkImage(photo) : null, child: photo.isEmpty ? const Icon(Icons.person, color: Colors.white70, size: 30) : null)), Positioned(right: 0, bottom: 1, child: Container(width: 17, height: 17, decoration: BoxDecoration(color: online ? const Color(0xFF20E65A) : Colors.white24, shape: BoxShape.circle, border: Border.all(color: _panel, width: 2))))])),
              const SizedBox(width: 13), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Row(children: [Flexible(child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w800))), if (verified || vip) ...[const SizedBox(width: 5), Icon(verified ? Icons.verified : Icons.verified, color: _gold, size: 18)]],), const SizedBox(height: 6), Text(preview, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xFFD4B9E1), fontSize: 14)), if (online) const Padding(padding: EdgeInsets.only(top: 4), child: Text('Online agora', style: TextStyle(color: Color(0xFF39E878), fontSize: 10)))])),
              const SizedBox(width: 8), Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Text(time, style: const TextStyle(color: Color(0xFFC9A6DC), fontSize: 11)), const SizedBox(height: 10), if (unread > 0) Container(width: 27, height: 27, alignment: Alignment.center, decoration: const BoxDecoration(color: _pink, shape: BoxShape.circle, boxShadow: [BoxShadow(color: _pink, blurRadius: 9)]), child: Text('$unread', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900))) else const Icon(Icons.chevron_right, color: _gold, size: 23)]),
            ]))));
          },
        );
      });
    },
  );

  Widget _empty() => Center(child: Padding(padding: const EdgeInsets.all(28), child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.forum_outlined, color: _purple.withOpacity(.8), size: 55), const SizedBox(height: 12), const Text('Suas conversas aparecerão aqui', style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.bold)), const SizedBox(height: 7), const Text('Toque em uma pessoa online para abrir uma conversa e enviar sua primeira mensagem.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white60, height: 1.4))])));

  String _formatTime(DateTime date) { final now = DateTime.now(); if (now.difference(date).inDays == 0) return '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}'; return '${date.day.toString().padLeft(2, '0')}/${date.month.toString().padLeft(2, '0')}'; }
}

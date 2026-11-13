import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getMessaging } from "firebase-admin/messaging";
import { getStorage } from "firebase-admin/storage";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { VideoIntelligenceServiceClient } from "@google-cloud/video-intelligence";

initializeApp();
const db = getFirestore();
const ABACATEPAY_API_KEY = defineSecret("ABACATEPAY_API_KEY");
const ABACATEPAY_WEBHOOK_SECRET = defineSecret("ABACATEPAY_WEBHOOK_SECRET");

// Baú da sala: pontos necessários para soltar a chuva de alianças e duração da chuva.
const CHEST_TARGET = 1000;
const DROP_LIFETIME_MS = 25000;
const RING_TYPES = [
  { id: "friends", name: "Aliança de Amigos", emoji: "💜" },
  { id: "couple", name: "Aliança de Namorados", emoji: "❤️" },
];

// A chuva de alianças só cai quando o baú enche (presentes ao anfitrião) e no
// máximo 1 vez a cada 5 dias por sala. Durante o intervalo o baú continua
// enchendo (fica cheio) e a chuva cai no primeiro presente depois dos 5 dias.
const RAIN_COOLDOWN_MS = 5 * 24 * 60 * 60 * 1000;



/** Concede a função de fundador somente à conta verificada definida no código.
 * O cliente não pode escolher o e-mail nem definir isAdmin diretamente.
 */
export const claimFounderAdmin = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta primeiro.");
  const email = String(request.auth.token.email ?? "").trim().toLowerCase();
  const emailVerified = request.auth.token.email_verified === true;
  if (email !== "adrielbispo3009@gmail.com" || !emailVerified) {
    throw new HttpsError("permission-denied", "Esta conta não está autorizada como administradora.");
  }
  const uid = request.auth.uid;
  await getAuth().setCustomUserClaims(uid, { admin: true, founder: true });
  await db.collection("users").doc(uid).set({
    uid, email, isAdmin: true, adminRole: "founder", adminGrantedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { success: true, role: "founder" };
});

/** Envia push para todos os dispositivos registrados do usuário destinatário. */
async function notifyUser(
  uid: string,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<void> {
  const tokensSnapshot = await db.collection("users").doc(uid)
    .collection("fcmTokens").get();
  const tokens = tokensSnapshot.docs
    .map((doc) => ({ id: doc.id, token: String(doc.data().token ?? doc.id) }))
    .filter((item) => item.token.length > 0);
  if (tokens.length === 0) return;

  const response = await getMessaging().sendEachForMulticast({
    tokens: tokens.map((item) => item.token),
    notification: { title, body },
    data,
    android: {
      priority: "high",
      notification: { channelId: "lovemix_updates", sound: "default" }
    }
  });

  const removals: Promise<unknown>[] = [];
  response.responses.forEach((result, index) => {
    const code = result.error?.code ?? "";
    if (!result.success && (
      code.includes("registration-token-not-registered") ||
      code.includes("invalid-registration-token")
    )) {
      removals.push(tokensSnapshot.docs[index].ref.delete());
    }
  });
  await Promise.all(removals);
}

/** Avisa os usuários quando uma transmissão pública começa. */
export const notifyOnLiveStarted = onDocumentCreated(
  "rooms/{roomId}",
  async (event) => {
    const room = event.data?.data();
    if (!room || room.isLive !== true || room.isPublic !== true) return;
    const hostUid = String(room.ownerId ?? "");
    if (!hostUid) return;

    const hostSnapshot = await db.collection("users").doc(hostUid).get();
    const hostName = String(hostSnapshot.data()?.name ?? "Alguém");
    const roomName = String(room.name ?? "uma live");
    const users = await db.collection("users").get();
    const recipients = users.docs.filter((user) => user.id !== hostUid);

    await Promise.all(recipients.map(async (user) => {
      try {
        await notifyUser(user.id, `🔴 ${hostName} está ao vivo!`,
          `Entre agora na live: ${roomName}`, {
            type: "live_started", roomId: event.params.roomId, fromUid: hostUid
          });
      } catch (error) {
        console.error(`Falha ao notificar live para ${user.id}`, error);
      }
    }));
  }
);

/** Notifica o destinatário quando alguém curte seu perfil. */
export const notifyOnLike = onDocumentCreated(
  "users/{fromUid}/likes/{targetUid}",
  async (event) => {
    const { fromUid, targetUid } = event.params;
    if (fromUid === targetUid) return;
    const sender = await db.collection("users").doc(fromUid).get();
    const name = String(sender.data()?.name ?? "Alguém");
    await notifyUser(targetUid, "Nova curtida ❤️", `${name} curtiu seu perfil.`, {
      type: "like", fromUid
    });
  }
);


/** Grava a notificação na central do app e também envia push ao dispositivo. */
async function createContentNotification(
  recipientUid: string,
  senderUid: string,
  type: "story_like" | "story_comment" | "post_like" | "post_comment",
  contentId: string,
  comment?: string
): Promise<void> {
  if (!recipientUid || !senderUid || recipientUid === senderUid) return;
  const senderSnap = await db.collection("users").doc(senderUid).get();
  const senderName = String(senderSnap.data()?.name ?? "Alguém");
  const isStory = type.startsWith("story_");
  const title = type.endsWith("like")
    ? (isStory ? "Curtiram seu story ❤️" : "Curtiram sua publicação ❤️")
    : (isStory ? "Comentaram no seu story 💬" : "Comentaram na sua publicação 💬");
  const body = type.endsWith("like")
    ? `${senderName} curtiu seu conteúdo.`
    : `${senderName}: ${String(comment ?? "Novo comentário").substring(0, 120)}`;
  const payload: Record<string, any> = {
    type,
    fromUid: senderUid,
    fromName: senderName,
    createdAt: FieldValue.serverTimestamp(),
    read: false,
    body,
  };
  payload[isStory ? "storyId" : "postId"] = contentId;

  await db.collection("users").doc(recipientUid)
    .collection("notifications").add(payload);

  await notifyUser(recipientUid, title, body, {
    type,
    fromUid: senderUid,
    ...(isStory ? { storyId: contentId } : { postId: contentId }),
  });
}

/** Notifica o dono quando outra pessoa curte ou comenta seu story. */
export const notifyOnStoryLike = onDocumentCreated(
  "stories/{storyId}/likes/{likerUid}",
  async (event) => {
    const like = event.data?.data();
    if (!like) return;
    const storySnap = await db.collection("stories").doc(event.params.storyId).get();
    if (!storySnap.exists) return;
    const story = storySnap.data() ?? {};
    const ownerUid = String(story.ownerId ?? "");
    const likerUid = String(like.uid ?? event.params.likerUid);
    const expiry = story.expiresAt as Timestamp | undefined;
    if (!ownerUid || !likerUid || (expiry && expiry.toMillis() <= Date.now())) return;
    await createContentNotification(ownerUid, likerUid, "story_like", event.params.storyId);
  }
);

export const notifyOnStoryComment = onDocumentCreated(
  "stories/{storyId}/comments/{commentId}",
  async (event) => {
    const comment = event.data?.data();
    if (!comment) return;
    const storySnap = await db.collection("stories").doc(event.params.storyId).get();
    if (!storySnap.exists) return;
    const story = storySnap.data() ?? {};
    const ownerUid = String(story.ownerId ?? "");
    const senderUid = String(comment.uid ?? "");
    const expiry = story.expiresAt as Timestamp | undefined;
    if (!ownerUid || !senderUid || (expiry && expiry.toMillis() <= Date.now())) return;
    await createContentNotification(
      ownerUid, senderUid, "story_comment", event.params.storyId, String(comment.text ?? "")
    );
  }
);

/** Notifica o autor de uma publicação do feed da Comunidade. */
export const notifyOnCommunityLike = onDocumentCreated(
  "feed_posts/{postId}/likes/{likerUid}",
  async (event) => {
    const like = event.data?.data();
    if (!like) return;
    const postSnap = await db.collection("feed_posts").doc(event.params.postId).get();
    if (!postSnap.exists) return;
    const ownerUid = String(postSnap.data()?.ownerId ?? "");
    const likerUid = String(like.uid ?? event.params.likerUid);
    await createContentNotification(ownerUid, likerUid, "post_like", event.params.postId);
  }
);

export const notifyOnCommunityComment = onDocumentCreated(
  "feed_posts/{postId}/comments/{commentId}",
  async (event) => {
    const comment = event.data?.data();
    if (!comment) return;
    const postSnap = await db.collection("feed_posts").doc(event.params.postId).get();
    if (!postSnap.exists) return;
    const ownerUid = String(postSnap.data()?.ownerId ?? "");
    await createContentNotification(
      ownerUid,
      String(comment.uid ?? ""),
      "post_comment",
      event.params.postId,
      String(comment.text ?? "")
    );
  }
);

/** Notifica o outro participante quando uma nova mensagem chega. */
export const notifyOnMessage = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;
    const senderUid = String(message.senderId ?? "");
    const chat = await db.collection("chats").doc(event.params.chatId).get();
    const participants = (chat.data()?.users ?? []) as string[];
    const recipientUid = participants.find((participant) => participant !== senderUid);
    if (!recipientUid || !senderUid) return;
    const sender = await db.collection("users").doc(senderUid).get();
    const name = String(sender.data()?.name ?? "Nova mensagem");
    const rawText = String(message.text ?? "");
    const preview = rawText.length > 100 ? `${rawText.substring(0, 97)}...` : rawText;
    await notifyUser(recipientUid, `Mensagem de ${name}`, preview, {
      type: "message", chatId: event.params.chatId, fromUid: senderUid
    });
  }
);


/** Notifica os participantes de uma sala sobre mensagens e presentes recebidos. */
export const notifyOnRoomActivity = onDocumentCreated(
  "rooms/{roomId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;
    const senderUid = String(message.senderId ?? "");
    const room = await db.collection("rooms").doc(event.params.roomId).get();
    const members = (room.data()?.members ?? []) as string[];
    const recipients = members.filter((member) => member !== senderUid);
    if (!senderUid || recipients.length === 0) return;
    const sender = await db.collection("users").doc(senderUid).get();
    const senderName = String(sender.data()?.name ?? "Alguém");
    const isGift = message.type === "gift";
    const body = isGift
      ? `${senderName} enviou ${String(message.emoji ?? "🎁")} ${String(message.giftName ?? "um presente")}.`
      : `${senderName}: ${String(message.text ?? "Nova mensagem").substring(0, 100)}`;
    await Promise.all(recipients.map((uid) => notifyUser(
      uid,
      isGift ? "Você recebeu um presente 🎁" : `Nova mensagem em ${String(room.data()?.name ?? "uma sala")}`,
      body,
      { type: isGift ? "room_gift" : "room_message", roomId: event.params.roomId, fromUid: senderUid }
    )));
  }
);

/**
 * Server-side like operation. Creates a match only after reciprocal like.
 * Clients must call this callable instead of writing match documents directly.
 */
export const likeUser = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const targetUid = String(request.data?.targetUid ?? "");
  if (!targetUid || targetUid === uid) {
    throw new HttpsError("invalid-argument", "Perfil de destino inválido.");
  }

  const targetRef = db.collection("users").doc(targetUid);
  const myLikeRef = db.collection("users").doc(uid).collection("likes").doc(targetUid);
  const theirLikeRef = db.collection("users").doc(targetUid).collection("likes").doc(uid);
  const matchUsers = [uid, targetUid].sort();
  const matchId = matchUsers.join("_");
  const matchRef = db.collection("matches").doc(matchId);
  let matched = false;

  await db.runTransaction(async (tx) => {
    const target = await tx.get(targetRef);
    if (!target.exists || target.data()?.isActive !== true) {
      throw new HttpsError("not-found", "Este perfil não está disponível.");
    }
    const blocked = await db.collection("users").doc(uid)
      .collection("blocked").doc(targetUid).get();
    const blockedByTarget = await db.collection("users").doc(targetUid)
      .collection("blocked").doc(uid).get();
    if (blocked.exists || blockedByTarget.exists) {
      throw new HttpsError("permission-denied", "Não é possível curtir este perfil.");
    }
    const reciprocal = await tx.get(theirLikeRef);
    tx.set(myLikeRef, { createdAt: FieldValue.serverTimestamp() });
    if (reciprocal.exists) {
      matched = true;
      tx.set(matchRef, {
        users: matchUsers,
        createdAt: FieldValue.serverTimestamp(),
        lastMessage: "",
        lastMessageAt: FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(db.collection("chats").doc(matchId), {
        users: matchUsers,
        lastMessage: "",
        lastMessageAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
  return { success: true, matched, matchId: matched ? matchId : null };
});



/** Resgata tarefas com validação no servidor e proteção contra resgate repetido. */
export const claimDailyTask = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const taskId = String(request.data?.taskId ?? "");
  const rewards: Record<string, number> = {
    daily_login: 30,
    complete_profile: 100,
    send_messages: 100,
    like_profiles: 50
  };
  const reward = rewards[taskId];
  if (!reward) throw new HttpsError("invalid-argument", "Tarefa inválida.");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("not-found", "Perfil não encontrado.");
  const profile = userSnap.data() ?? {};

  if (taskId === "complete_profile") {
    if (!String(profile.photoUrl ?? "").trim() || !String(profile.bio ?? "").trim()) {
      throw new HttpsError("failed-precondition", "Adicione uma foto e uma bio para concluir esta tarefa.");
    }
  } else if (taskId === "send_messages") {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const messages = await db.collectionGroup("messages")
      .where("senderId", "==", uid)
      .where("createdAt", ">=", Timestamp.fromDate(today))
      .limit(10).get();
    const completed = messages.size >= 10;
    if (!completed) throw new HttpsError("failed-precondition", "Envie 10 mensagens hoje para resgatar esta recompensa.");
  } else if (taskId === "like_profiles") {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const likes = await userRef.collection("likes")
      .where("createdAt", ">=", Timestamp.fromDate(today)).limit(5).get();
    const completed = likes.size >= 5;
    if (!completed) throw new HttpsError("failed-precondition", "Curta 5 perfis hoje para resgatar esta recompensa.");
  }

  const now = new Date();
  const dayKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  const claimKey = taskId === "complete_profile" ? taskId : `${dayKey}_${taskId}`;
  const claimRef = userRef.collection("taskClaims").doc(claimKey);
  await db.runTransaction(async (tx) => {
    const [claim, currentUser] = await Promise.all([tx.get(claimRef), tx.get(userRef)]);
    if (claim.exists) throw new HttpsError("already-exists", "Você já resgatou esta tarefa no período atual.");
    if (!currentUser.exists) throw new HttpsError("not-found", "Perfil não encontrado.");
    tx.set(claimRef, { taskId, reward, claimedAt: FieldValue.serverTimestamp() });
    tx.update(userRef, { coins: FieldValue.increment(reward) });
  });
  return { success: true, coins: reward };
});


/** Envio de presentes dentro da sala: valida participantes e saldo no servidor. */


/** Resgate de códigos promocionais: cada conta pode resgatar cada código uma única vez; outras contas também podem usar o mesmo código. */
const PROMO_CODES: Record<string, { kind: "vip" | "wallet" }> = {
  "LMVIP7KQ2M9X": { kind: "vip" },
  "LMVIP4PZ8R3W": { kind: "vip" },
  "LMVIP9T6N2KC": { kind: "vip" },
  "LMVIP5XQ7D4JA": { kind: "vip" },
  "LMVIP2H8W6RTP": { kind: "vip" },
  "LMVIP8C3M5YQ": { kind: "vip" },
  "LMVIP6J4V9K2P": { kind: "vip" },
  "LMVIP3R7X2N8D": { kind: "vip" },
  "LMVIPW5K9T3Q2": { kind: "vip" },
  "LMVIPQ8D4M7X1": { kind: "vip" },
  "LMVIPN2P6R9W3": { kind: "vip" },
  "LMVIPY7C5K2J8": { kind: "vip" },
  "LMVIPD4T9X6M1": { kind: "vip" },
  "LMVIPR8W3Q5N2": { kind: "vip" },
  "LMVIPK6J2P9V4": { kind: "vip" },
  "LMVIPX3M7D5R8": { kind: "vip" },
  "LMVIPT9Q4N6C2": { kind: "vip" },
  "LMVIPH5V8K3P7": { kind: "vip" },
  "LMVIPM2R6X9D4": { kind: "vip" },
  "LMVIPC7W3J8Q5": { kind: "vip" },
  "LMCOIN7K2P9X": { kind: "wallet" },
  "LMCOIN4R8W3Q": { kind: "wallet" },
  "LMCOIN9T6M2C": { kind: "wallet" },
  "LMCOIN5XQ7D4J": { kind: "wallet" },
  "LMCOIN2H8W6RTP": { kind: "wallet" },
  "LMCOIN8C3M5YQ": { kind: "wallet" },
  "LMCOIN6J4V9K2P": { kind: "wallet" },
  "LMCOIN3R7X2N8D": { kind: "wallet" },
  "LMCOINW5K9T3Q2": { kind: "wallet" },
  "LMCOINQ8D4M7X1": { kind: "wallet" },
  "LMCOINN2P6R9W3": { kind: "wallet" },
  "LMCOINY7C5K2J8": { kind: "wallet" },
  "LMCOIND4T9X6M1": { kind: "wallet" },
  "LMCOINR8W3Q5N2": { kind: "wallet" },
  "LMCOINK6J2P9V4": { kind: "wallet" },
  "LMCOINX3M7D5R8": { kind: "wallet" },
  "LMCOINT9Q4N6C2": { kind: "wallet" },
  "LMCOINH5V8K3P7": { kind: "wallet" },
  "LMCOINM2R6X9D4": { kind: "wallet" },
  "LMCOINC7W3J8Q5": { kind: "wallet" },
  "LMCOINV7Q2K9X4": { kind: "wallet" },
  "LMCOINB4N8R3W6": { kind: "wallet" },
  "LMCOINZ9T6M2C5": { kind: "wallet" },
  "LMCOINA5XQ7D4J8": { kind: "wallet" },
  "LMCOINF2H8W6RTP3": { kind: "wallet" },
  "LMCOING8C3M5YQ7": { kind: "wallet" },
  "LMCOIL6J4V9K2P5": { kind: "wallet" },
  "LMCOIU3R7X2N8D6": { kind: "wallet" },
  "LMCOIE5K9T3Q2W": { kind: "wallet" },
  "LMCOIO8D4M7X1Q": { kind: "wallet" },
  "LMCOIL2P6R9W3N": { kind: "wallet" },
  "LMCOIE7C5K2J8Y": { kind: "wallet" },
  "LMCOIA4T9X6M1D": { kind: "wallet" },
  "LMCOIU8W3Q5N2R": { kind: "wallet" },
  "LMCOIN6J2P9V4K": { kind: "wallet" },
  "LMCOIZ3M7D5R8X": { kind: "wallet" },
  "LMCOIT9Q4N6C2H": { kind: "wallet" },
  "LMCOIF5V8K3P7J": { kind: "wallet" },
  "LMCOIN2R6X9D4M": { kind: "wallet" },
  "LMCOIE7W3J8Q5C": { kind: "wallet" },
};



/** Cria cobranças Pix com catálogo e valores definidos exclusivamente no servidor. */
export const createLoveMixPix = onCall({ secrets: [ABACATEPAY_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const productId = String(request.data?.productId ?? "");
  const catalog: Record<string, { amount: number; coins: number; vipDays?: number; description: string }> = {
    coins_1000: { amount: 490, coins: 1000, description: "LoveMix - 1.000 moedas" },
    coins_2500: { amount: 990, coins: 2500, description: "LoveMix - 2.500 moedas" },
    coins_6000: { amount: 1990, coins: 6000, description: "LoveMix - 6.000 moedas" },
    vip_30d: { amount: 990, coins: 2000, vipDays: 30, description: "LoveMix VIP por 30 dias + 2.000 moedas" },
  };
  const product = catalog[productId];
  if (!product) throw new HttpsError("invalid-argument", "Produto não encontrado.");
  const user = await db.collection("users").doc(uid).get();
  if (!user.exists) throw new HttpsError("not-found", "Perfil não encontrado.");
  const orderRef = db.collection("loveMixPixOrders").doc();
  const apiKey = ABACATEPAY_API_KEY.value();
  if (!apiKey) throw new HttpsError("failed-precondition", "Pagamento ainda não configurado no servidor.");
  const response = await fetch("https://api.abacatepay.com/v2/transparents/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "PIX", data: {
      amount: product.amount, description: product.description, expiresIn: 1800,
      externalId: orderRef.id, metadata: { uid, productId, orderId: orderRef.id }
    } })
  });
  const payload = await response.json() as any;
  if (!response.ok || payload?.success === false) {
    console.error("AbacatePay create error", payload);
    throw new HttpsError("unavailable", "Não foi possível criar o Pix. Confira a chave v2 e tente novamente.");
  }
  const pix = payload?.data ?? payload;
  const pixId = String(pix.id ?? "");
  const brCode = String(pix.brCode ?? "");
  if (!pixId || !brCode) throw new HttpsError("internal", "A AbacatePay não retornou os dados do Pix.");
  await orderRef.set({ uid, productId, amount: product.amount, coins: product.coins,
    vipDays: product.vipDays ?? 0, pixId, status: "PENDING", createdAt: FieldValue.serverTimestamp() });
  return { orderId: orderRef.id, brCode, brCodeBase64: pix.brCodeBase64 ?? "", pixId,
    amount: product.amount, productId };
});

/** Recebe a confirmação automática da AbacatePay. */
export const abacatePayWebhook = onRequest(
  { secrets: [ABACATEPAY_WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const expectedSecret = ABACATEPAY_WEBHOOK_SECRET.value();
    const receivedSecret = String(req.get("X-Webhook-Secret") ?? req.query.webhookSecret ?? "");
    const expectedBytes = Buffer.from(expectedSecret, "utf8");
    const receivedBytes = Buffer.from(receivedSecret, "utf8");
    if (!expectedSecret || expectedBytes.length !== receivedBytes.length ||
        !timingSafeEqual(expectedBytes, receivedBytes)) {
      res.status(401).send("Unauthorized");
      return;
    }

    const rawBody = req.rawBody;
    const signature = String(req.get("X-Webhook-Signature") ?? "");
    const signingKey = "t9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9";
    const expectedSignature = createHmac("sha256", signingKey).update(rawBody).digest("base64");
    const expectedSigBytes = Buffer.from(expectedSignature, "utf8");
    const receivedSigBytes = Buffer.from(signature, "utf8");
    if (!signature || expectedSigBytes.length !== receivedSigBytes.length ||
        !timingSafeEqual(expectedSigBytes, receivedSigBytes)) {
      res.status(401).send("Invalid signature");
      return;
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).send("Invalid JSON");
      return;
    }

    if (event?.event !== "transparent.completed") {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    const transparent = event?.data?.transparent ?? {};
    const eventId = String(event?.id ?? "");
    const orderId = String(transparent.externalId ?? transparent.metadata?.orderId ?? "");
    const pixId = String(transparent.id ?? "");
    const amount = Number(transparent.amount);
    if (!eventId || !orderId || !pixId || !Number.isFinite(amount) ||
        String(transparent.status ?? "").toUpperCase() !== "PAID") {
      res.status(400).send("Missing payment data");
      return;
    }

    const orderRef = db.collection("loveMixPixOrders").doc(orderId);
    try {
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) throw new Error("Unknown order");
        const order = orderSnap.data()!;
        if (String(order.pixId) !== pixId || Number(order.amount) !== amount) {
          throw new Error("Payment does not match order");
        }
        const eventRef = db.collection("abacatePayWebhookEvents").doc(eventId);
        const eventSnap = await tx.get(eventRef);
        if (eventSnap.exists || order.status === "PAID") return;
        const userRef = db.collection("users").doc(String(order.uid));
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new Error("User not found");
        const update: Record<string, any> = {
          coins: FieldValue.increment(Number(order.coins ?? 0)),
          lastPurchaseAt: FieldValue.serverTimestamp(),
        };
        const vipDays = Number(order.vipDays ?? 0);
        if (vipDays > 0) {
          const current = userSnap.data()?.vipExpiresAt as Timestamp | undefined;
          const base = current && current.toMillis() > Date.now() ? current.toMillis() : Date.now();
          update.isVip = true;
          update.vipExpiresAt = Timestamp.fromMillis(base + vipDays * 24 * 60 * 60 * 1000);
          update.vipGrantedAt = FieldValue.serverTimestamp();
        }
        tx.update(userRef, update);
        tx.update(orderRef, { status: "PAID", paidAt: FieldValue.serverTimestamp(), paidBy: "webhook" });
        tx.create(eventRef, { event: event.event, orderId, pixId, processedAt: FieldValue.serverTimestamp() });
      });
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("AbacatePay webhook processing failed", error);
      res.status(500).send("Could not process payment event");
    }
  }
);

/** Confirma o Pix consultando a AbacatePay no servidor e credita uma única vez. */
export const confirmLoveMixPix = onCall({ secrets: [ABACATEPAY_API_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const orderId = String(request.data?.orderId ?? "");
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(orderId)) throw new HttpsError("invalid-argument", "Pedido inválido.");
  const orderRef = db.collection("loveMixPixOrders").doc(orderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists || orderSnap.data()?.uid !== request.auth.uid)
    throw new HttpsError("not-found", "Pedido não encontrado.");
  const order = orderSnap.data()!;
  if (order.status === "PAID") return { paid: true };
  const apiKey = ABACATEPAY_API_KEY.value();
  const url = `https://api.abacatepay.com/v2/transparents/check?id=${encodeURIComponent(String(order.pixId))}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const payload = await response.json() as any;
  if (!response.ok) {
    console.error("AbacatePay check error", payload);
    throw new HttpsError("unavailable", "Não foi possível consultar o Pix agora.");
  }
  const pix = payload?.data ?? payload;
  if (String(pix.status ?? "").toUpperCase() !== "PAID") return { paid: false };
  if (Number(pix.amount ?? order.amount) !== Number(order.amount))
    throw new HttpsError("failed-precondition", "O valor confirmado não corresponde ao pedido.");
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(orderRef);
    if (!fresh.exists || fresh.data()?.uid !== request.auth!.uid) throw new HttpsError("not-found", "Pedido não encontrado.");
    if (fresh.data()?.status === "PAID") return;
    const userRef = db.collection("users").doc(request.auth!.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "Perfil não encontrado.");
    const update: Record<string, any> = {
      coins: FieldValue.increment(Number(fresh.data()?.coins ?? 0)),
      lastPurchaseAt: FieldValue.serverTimestamp()
    };
    const vipDays = Number(fresh.data()?.vipDays ?? 0);
    if (vipDays > 0) {
      const current = userSnap.data()?.vipExpiresAt as Timestamp | undefined;
      const base = current && current.toMillis() > Date.now() ? current.toMillis() : Date.now();
      update.isVip = true;
      update.vipExpiresAt = Timestamp.fromMillis(base + vipDays * 24 * 60 * 60 * 1000);
      update.vipGrantedAt = FieldValue.serverTimestamp();
    }
    tx.update(userRef, update);
    tx.update(orderRef, { status: "PAID", paidAt: FieldValue.serverTimestamp() });
  });
  return { paid: true };
});

export const redeemLoveMixCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const code = String(request.data?.code ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const reward = PROMO_CODES[code];
  if (!reward) throw new HttpsError("not-found", "Código inválido.");
  const uid = request.auth.uid;
  const codeRef = db.collection("promoCodeClaims").doc(`${code}_${uid}`);
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const [claim, user] = await Promise.all([tx.get(codeRef), tx.get(userRef)]);
    if (claim.exists) throw new HttpsError("already-exists", "Você já resgatou este código nesta conta.");
    if (!user.exists) throw new HttpsError("not-found", "Perfil não encontrado.");
    if (reward.kind === "vip") {
      tx.set(codeRef, { uid, reward: "vip", claimedAt: FieldValue.serverTimestamp() });
      tx.update(userRef, { isVip: true, vipGrantedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(codeRef, { uid, reward: "wallet", coins: 2000, diamonds: 2000, claimedAt: FieldValue.serverTimestamp() });
      tx.update(userRef, { coins: FieldValue.increment(2000), diamonds: FieldValue.increment(2000) });
    }
  });
  return reward.kind === "vip" ? { success: true, reward: "vip" } : { success: true, reward: "wallet", coins: 2000, diamonds: 2000 };
});

/** Encerra automaticamente o selo VIP quando o período comprado termina. */
export const expireLoveMixVip = onSchedule("every 60 minutes", async () => {
  const now = Timestamp.now();
  const expired = await db.collection("users")
    .where("isVip", "==", true)
    .where("vipExpiresAt", "<=", now)
    .limit(400).get();
  if (expired.empty) return;
  const batch = db.batch();
  expired.docs.forEach((doc) => batch.update(doc.ref, { isVip: false, vipExpiredAt: FieldValue.serverTimestamp() }));
  await batch.commit();
});

/** Compra molduras de perfil com saldo validado no servidor. */
export const purchaseProfileFrame = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const frameId = String(request.data?.frameId ?? "");
  const catalog: Record<string, { name: string; currency: "coins" | "diamonds"; cost: number }> = {
    neon: { name: "Neon Love", currency: "coins", cost: 250 },
    hearts: { name: "Corações", currency: "coins", cost: 400 },
    gold: { name: "Dourada VIP", currency: "diamonds", cost: 50 },
    cosmic: { name: "Galáxia", currency: "diamonds", cost: 100 },
    royal_crown: { name: "Rainha Real", currency: "diamonds", cost: 80 },
    kitty: { name: "Gatinho", currency: "coins", cost: 500 },
    butterfly: { name: "Borboletas", currency: "coins", cost: 550 },
    rose: { name: "Rosa Negra", currency: "coins", cost: 600 },
    headphones: { name: "Music Love", currency: "coins", cost: 450 },
    pink_bow: { name: "Laço Rosa", currency: "coins", cost: 450 },
    flame: { name: "Chamas", currency: "diamonds", cost: 70 },
    angel: { name: "Asas de Anjo", currency: "diamonds", cost: 90 },
    love_wings: { name: "Asas LoveMix", currency: "diamonds", cost: 120 },
    flower: { name: "Jardim", currency: "coins", cost: 500 },
    sparkle: { name: "Estrelas", currency: "coins", cost: 350 },
    diamond_heart: { name: "Coração de Diamante", currency: "diamonds", cost: 110 },
    broken_heart: { name: "Coração Rebelde", currency: "coins", cost: 400 },
    royal_purple: { name: "Realeza Roxa", currency: "diamonds", cost: 75 },
    couple: { name: "Casal Apaixonado", currency: "coins", cost: 650 },
    butterfly_royal: { name: "Borboleta Real", currency: "diamonds", cost: 130 },
    rose_gold: { name: "Rosa de Ouro", currency: "diamonds", cost: 140 },
    celestial: { name: "Celestial VIP", currency: "diamonds", cost: 150 },
    royal_wings: { name: "Asas da Realeza", currency: "diamonds", cost: 160 },
    diamond_crown: { name: "Coroa de Diamantes", currency: "diamonds", cost: 180 },
    lovemix_deluxe: { name: "LoveMix Deluxe", currency: "diamonds", cost: 200 },
  };
  const item = catalog[frameId];
  if (!item) throw new HttpsError("invalid-argument", "Moldura não encontrada.");
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new HttpsError("not-found", "Perfil não encontrado.");
    const data = snap.data() ?? {};
    const owned = Array.isArray(data.ownedProfileFrames) ? data.ownedProfileFrames as string[] : ["classic"];
    if (owned.includes(frameId)) return;
    if (item.currency === "diamonds") {
      const expiry = data.vipExpiresAt as Timestamp | undefined;
      const vipActive = data.isVip === true && (!expiry || expiry.toMillis() > Date.now());
      if (!vipActive) throw new HttpsError("permission-denied", "Esta moldura é exclusiva para assinantes VIP.");
    }
    const balance = Number(data[item.currency] ?? 0);
    if (balance < item.cost) throw new HttpsError("failed-precondition", `Saldo insuficiente de ${item.currency === "coins" ? "moedas" : "diamantes"}.`);
    tx.update(userRef, { [item.currency]: FieldValue.increment(-item.cost), ownedProfileFrames: [...owned, frameId] });
  });
  return { success: true, frameId, name: item.name };
});

export const sendRoomGift = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const roomId = String(request.data?.roomId ?? "");
  const recipientUid = String(request.data?.recipientUid ?? "");
  const giftId = String(request.data?.giftId ?? "");
  if (!roomId || !recipientUid) {
    throw new HttpsError("invalid-argument", "Escolha uma pessoa válida na sala.");
  }
  const catalog: Record<string, { name: string; emoji: string; currency: "coins" | "diamonds"; cost: number }> = {
    rose: { name: "Rosa", emoji: "🌹", currency: "coins", cost: 50 },
    gift: { name: "Presente", emoji: "🎁", currency: "coins", cost: 100 },
    heart: { name: "Coração", emoji: "💗", currency: "coins", cost: 200 },
    crown: { name: "Coroa", emoji: "👑", currency: "diamonds", cost: 50 },
    diamond: { name: "Diamante", emoji: "💎", currency: "diamonds", cost: 100 },
    lamborghini: { name: "Lamborghini", emoji: "🏎️", currency: "diamonds", cost: 5000 },
    iphone18: { name: "iPhone 18", emoji: "📱", currency: "coins", cost: 13000 },
    curtir: { name: "Curtir", emoji: "👍", currency: "coins", cost: 1 },
    moinho: { name: "Moinho de vento", emoji: "🌀", currency: "coins", cost: 129 },
    bugatti: { name: "Bugatti", emoji: "🏎️", currency: "diamonds", cost: 15992 },
    tulipas: { name: "Tulipas", emoji: "🌷", currency: "coins", cost: 29 },
    bugatti_dourado: { name: "Bugatti Dourado", emoji: "🚘", currency: "diamonds", cost: 29999 },
    rosa_dinheiro: { name: "Rosa de Dinheiro", emoji: "🏵️", currency: "coins", cost: 199 },
    abraco: { name: "Quero um abraço", emoji: "🤗", currency: "coins", cost: 999 },
    motocicleta: { name: "Motocicleta", emoji: "🏍️", currency: "diamonds", cost: 1992 },
    carro_brilhante: { name: "Carro brilhante", emoji: "🚙", currency: "diamonds", cost: 3992 },
    "18pm": { name: "18PM", emoji: "📱", currency: "diamonds", cost: 3999 },
    iphone_duo: { name: "iPhone DUO", emoji: "📲", currency: "diamonds", cost: 5999 },
    xesla: { name: "Xesla Roadster", emoji: "🏁", currency: "diamonds", cost: 9999 },
    fogos: { name: "Fogos de artifício", emoji: "🎆", currency: "diamonds", cost: 1592 },
    bom_dia: { name: "Bom dia", emoji: "☀️", currency: "coins", cost: 59 },
    boa_tarde: { name: "Boa tarde", emoji: "☕", currency: "coins", cost: 59 },
    boa_noite: { name: "Boa noite", emoji: "🌙", currency: "coins", cost: 59 },
    hipopotamo: { name: "Hipopótamo", emoji: "🦛", currency: "coins", cost: 899 },
    cervo_neon: { name: "Cervo Neon", emoji: "🦌", currency: "diamonds", cost: 1999 },
    carroca: { name: "Carroça de Confete", emoji: "🎉", currency: "diamonds", cost: 99999 },
    shawarma: { name: "Shawarma", emoji: "🌯", currency: "coins", cost: 599 },
    cachorro_maluco: { name: "Cachorro Maluco", emoji: "🐶", currency: "coins", cost: 599 },
    pequena_bomba: { name: "Pequena Bomba", emoji: "💣", currency: "coins", cost: 999 },
    tigre_chamas: { name: "Tigre de Chamas", emoji: "🐯", currency: "diamonds", cost: 59999 },
    dj_rato: { name: "DJ Rato", emoji: "🎧", currency: "diamonds", cost: 9999 },
    romance_mar: { name: "Romance do Mar", emoji: "🐋", currency: "diamonds", cost: 159999 },
    gloria_leao: { name: "Glória do Leão Dourado", emoji: "👑", currency: "diamonds", cost: 199999 },
    festa_hbd: { name: "Festa HBD", emoji: "🎂", currency: "diamonds", cost: 1999 },
    curte_se: { name: "Curte-se!", emoji: "😍", currency: "coins", cost: 199 },
    batom: { name: "Batom", emoji: "💄", currency: "coins", cost: 129 },
    forca_brasil: { name: "Força Brasil", emoji: "🇧🇷", currency: "coins", cost: 129 },
    leao: { name: "Leão", emoji: "🦁", currency: "diamonds", cost: 79999 },
    alliance: { name: "Aliança", emoji: "💍", currency: "diamonds", cost: 500 },
    diamond_alliance: { name: "Aliança de Diamantes", emoji: "💎", currency: "diamonds", cost: 1000 },
    wedding_bouquet: { name: "Buquê de Casamento", emoji: "💐", currency: "diamonds", cost: 800 },
    teddy_bear: { name: "Urso de Pelúcia", emoji: "🧸", currency: "coins", cost: 400 },
    magic_castle: { name: "Castelo Mágico", emoji: "🏰", currency: "diamonds", cost: 1500 },
    luxury_yacht: { name: "Iate de Luxo", emoji: "🛥️", currency: "diamonds", cost: 1500 },
    diamond_chest: { name: "Baú de Diamantes", emoji: "🧰", currency: "diamonds", cost: 1000 },
    shining_star: { name: "Estrela Brilhante", emoji: "🌟", currency: "diamonds", cost: 200 },
  };
  const item = catalog[giftId];
  if (!item) throw new HttpsError("invalid-argument", "Presente não encontrado.");
  const roomRef = db.collection("rooms").doc(roomId);
  const senderRef = db.collection("users").doc(uid);
  const recipientRef = db.collection("users").doc(recipientUid);
  const messageRef = roomRef.collection("messages").doc();
  const dropRef = roomRef.collection("drops").doc();
  const systemMessageRef = roomRef.collection("messages").doc();
  let dropped = false;
  await db.runTransaction(async (tx) => {
    const [roomSnap, senderSnap, recipientSnap] = await Promise.all([
      tx.get(roomRef), tx.get(senderRef), tx.get(recipientRef)
    ]);
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "A sala desta transmissão não foi encontrada. Saia e entre novamente na sala.");
    }
    if (!senderSnap.exists) {
      throw new HttpsError("not-found", "Seu perfil não foi encontrado. Entre novamente na sua conta.");
    }
    if (!recipientSnap.exists) {
      throw new HttpsError("not-found", "O perfil de quem vai receber o presente não foi encontrado.");
    }
    const roomData: any = roomSnap.data() ?? {};
    const members = Array.isArray(roomData.members) ? roomData.members as string[] : [];
    const roomOwnerId = String(roomData.ownerId ?? "");
    // O anfitrião é participante por definição. Salas antigas podem não ter
    // o ownerId sincronizado em `members`; isso não deve bloquear auto-presente.
    const ownerSelfGift = recipientUid === uid && roomOwnerId === uid;
    if ((!members.includes(uid) && !ownerSelfGift) ||
        (!members.includes(recipientUid) && !ownerSelfGift)) {
      throw new HttpsError("permission-denied", "Entre na sala antes de enviar presentes.");
    }
    if (recipientUid === uid && !ownerSelfGift) {
      throw new HttpsError("permission-denied", "Somente o anfitrião pode enviar presente para si mesmo.");
    }
    const balance = Number(senderSnap.data()?.[item.currency] ?? 0);
    if (balance < item.cost) {
      throw new HttpsError("failed-precondition", `Saldo insuficiente de ${item.currency === "coins" ? "moedas" : "diamantes"}.`);
    }
    tx.update(senderRef, { [item.currency]: FieldValue.increment(-item.cost) });
    tx.set(messageRef, {
      senderId: uid, recipientUid, giftId, giftName: item.name, emoji: item.emoji,
      currency: item.currency, cost: item.cost, type: "gift",
      text: `${item.emoji} ${item.name}`, createdAt: FieldValue.serverTimestamp()
    });
    const roomUpdate: any = {
      lastMessage: `${item.emoji} Presente enviado`,
      lastMessageAt: FieldValue.serverTimestamp()
    };

    // Baú da sala: só enche com presentes enviados ao anfitrião (dono da sala)
    // ou a um administrador do app. Diamantes valem 10x mais pontos que moedas.
    const ownerId = String(roomData.ownerId ?? "");
    const toAdmin = recipientUid === ownerId || recipientSnap.data()?.isAdmin === true;
    if (toAdmin) {
      const points = item.currency === "diamonds" ? item.cost * 10 : item.cost;
      let chest = Number(roomData.chestPoints ?? 0) + points;
      roomUpdate.giftScore = FieldValue.increment(points);
      roomUpdate.chestTarget = CHEST_TARGET;
      const lastRain = roomData.lastRainAt as Timestamp | undefined;
      const rainReady = !lastRain || Date.now() - lastRain.toMillis() >= RAIN_COOLDOWN_MS;
      if (chest >= CHEST_TARGET && !rainReady) {
        chest = CHEST_TARGET; // baú cheio, esperando o intervalo de 5 dias
      } else if (chest >= CHEST_TARGET) {
        chest = chest % CHEST_TARGET;
        roomUpdate.lastRainAt = FieldValue.serverTimestamp();
        const ring = RING_TYPES[Math.floor(Math.random() * RING_TYPES.length)];
        tx.set(dropRef, {
          status: "open", ringType: ring.id, ringName: ring.name, emoji: ring.emoji,
          triggeredBy: uid, recipientUid, claimedBy: null,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + DROP_LIFETIME_MS)
        });
        tx.set(systemMessageRef, {
          senderId: "system", type: "system",
          text: `🧰 O baú abriu! Chuva de ${ring.name}! Só uma pessoa consegue pegar. Toque na aliança! 💍`,
          createdAt: FieldValue.serverTimestamp()
        });
        roomUpdate.chestDrops = FieldValue.increment(1);
        dropped = true;
      }
      roomUpdate.chestPoints = chest;
    }

    // Recompensa do anfitrião: somente presentes enviados ao dono da live.
    // Presentes em moedas pagam 1:1; presentes em diamantes pagam 10 moedas por diamante.
    if (recipientUid === ownerId && uid !== recipientUid) {
      const hostCoins = item.currency === "diamonds" ? item.cost * 10 : item.cost;
      tx.update(recipientRef, { coins: FieldValue.increment(hostCoins) });
      roomUpdate.liveCoinEarnings = FieldValue.increment(hostCoins);
    }

    // Carisma aumenta ao receber presentes de terceiros e também quando o
    // anfitrião envia um presente para si mesmo. Auto-presentes não geram
    // moedas de recompensa nem pontos extras no baú, apenas carisma.
    if (uid !== recipientUid || recipientUid === ownerId) {
      const charisma = item.currency === "diamonds" ? item.cost * 10 : item.cost;
      tx.update(recipientRef, { charisma: FieldValue.increment(charisma) });
    }
    tx.update(roomRef, roomUpdate);
  });
  return { success: true, giftId, chestOpened: dropped };
});

/** Quem toca primeiro numa aliança da chuva do baú leva; só uma pessoa por chuva. */
export const claimRoomDrop = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const roomId = String(request.data?.roomId ?? "");
  const dropId = String(request.data?.dropId ?? "");
  if (!roomId || !dropId) throw new HttpsError("invalid-argument", "Chuva inválida.");
  const roomRef = db.collection("rooms").doc(roomId);
  const dropRef = roomRef.collection("drops").doc(dropId);
  const userRef = db.collection("users").doc(uid);
  const itemRef = userRef.collection("receivedItems").doc();
  const systemMessageRef = roomRef.collection("messages").doc();
  const result = await db.runTransaction(async (tx) => {
    const [roomSnap, dropSnap, userSnap] = await Promise.all([
      tx.get(roomRef), tx.get(dropRef), tx.get(userRef)
    ]);
    if (!roomSnap.exists || !dropSnap.exists) {
      throw new HttpsError("not-found", "Essa chuva de alianças não existe mais.");
    }
    const members = ((roomSnap.data() as any)?.members ?? []) as string[];
    if (!members.includes(uid)) {
      throw new HttpsError("permission-denied", "Entre na sala para pegar a aliança.");
    }
    const drop: any = dropSnap.data() ?? {};
    if (drop.status !== "open") {
      throw new HttpsError("already-exists", "Outra pessoa foi mais rápida e pegou a aliança! 💨");
    }
    const expiresAt = drop.expiresAt as Timestamp | undefined;
    if (!expiresAt || expiresAt.toMillis() < Date.now()) {
      tx.update(dropRef, { status: "expired" });
      throw new HttpsError("failed-precondition", "A chuva de alianças já acabou.");
    }
    const name = String(userSnap.data()?.name ?? "Alguém").split(" ")[0];
    tx.update(dropRef, {
      status: "claimed", claimedBy: uid, claimedByName: name,
      claimedAt: FieldValue.serverTimestamp()
    });
    tx.set(itemRef, {
      fromUid: "system", itemType: drop.ringType === "couple" ? "room_ring_couple" : "room_ring_friends",
      itemName: String(drop.ringName ?? "Aliança"), emoji: "💍", currency: "coins", cost: 0,
      status: "received", source: "room_chest", roomId, createdAt: FieldValue.serverTimestamp()
    });
    tx.set(systemMessageRef, {
      senderId: "system", type: "system",
      text: `💍 ${name} pegou a ${String(drop.ringName ?? "aliança")}! Na próxima pode ser você.`,
      createdAt: FieldValue.serverTimestamp()
    });
    return { ringName: String(drop.ringName ?? "Aliança") };
  });
  return { success: true, ringName: result.ringName };
});

/** Envia presentes/alianças usando preços definidos exclusivamente no servidor. */
export const sendStoreItem = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const uid = request.auth.uid;
  const targetUid = String(request.data?.targetUid ?? "");
  const itemType = String(request.data?.itemType ?? "");
  if (!targetUid || targetUid === uid) {
    throw new HttpsError("invalid-argument", "Escolha outra pessoa para receber o item.");
  }

  const catalog: Record<string, { name: string; emoji: string; currency: "coins" | "diamonds"; cost: number; category: "gift" | "alliance" | "free" }> = {
    "gift:Rosa": { name: "Rosa", emoji: "🌹", currency: "coins", cost: 50, category: "gift" },
    "gift:Ursinho": { name: "Ursinho", emoji: "🧸", currency: "coins", cost: 100, category: "gift" },
    "gift:Coração": { name: "Coração", emoji: "❤️", currency: "coins", cost: 200, category: "gift" },
    "gift:Bolo": { name: "Bolo", emoji: "🎂", currency: "coins", cost: 300, category: "gift" },
    "gift:Buquê": { name: "Buquê", emoji: "💐", currency: "diamonds", cost: 15, category: "gift" },
    "gift:Coroa": { name: "Coroa", emoji: "👑", currency: "diamonds", cost: 50, category: "gift" },
    "gift:Diamante": { name: "Diamante", emoji: "💎", currency: "diamonds", cost: 100, category: "gift" },
    "gift:Carro de luxo": { name: "Carro de luxo", emoji: "🚗", currency: "diamonds", cost: 150, category: "gift" },
    "bff:Aliança BFF": { name: "Aliança BFF", emoji: "💜", currency: "coins", cost: 250, category: "alliance" },
    "siblings:Aliança Irmãos": { name: "Aliança Irmãos", emoji: "💙", currency: "coins", cost: 300, category: "alliance" },
    "couple:Aliança Casal": { name: "Aliança Casal", emoji: "❤️", currency: "diamonds", cost: 50, category: "alliance" },
    "free_bff:Aliança BFF grátis": { name: "Aliança BFF grátis", emoji: "💛", currency: "coins", cost: 0, category: "free" }
  };
  const item = catalog[`${itemType}:${String(request.data?.itemName ?? "")}`];
  if (!item) throw new HttpsError("invalid-argument", "Presente ou aliança não encontrado.");

  const senderRef = db.collection("users").doc(uid);
  const recipientRef = db.collection("users").doc(targetUid);
  const senderBlockRef = senderRef.collection("blocked").doc(targetUid);
  const recipientBlockRef = recipientRef.collection("blocked").doc(uid);
  const freeClaimRef = senderRef.collection("freeAllianceClaims").doc("bff");
  const deliveryRef = recipientRef.collection("receivedItems").doc();

  await db.runTransaction(async (tx) => {
    const [sender, recipient, senderBlock, recipientBlock, freeClaim] = await Promise.all([
      tx.get(senderRef), tx.get(recipientRef), tx.get(senderBlockRef),
      tx.get(recipientBlockRef), item.category === "free" ? tx.get(freeClaimRef) : Promise.resolve(null)
    ]);
    if (!sender.exists || !recipient.exists || recipient.data()?.isActive !== true) {
      throw new HttpsError("not-found", "A pessoa escolhida não está disponível.");
    }
    if (senderBlock.exists || recipientBlock.exists) {
      throw new HttpsError("permission-denied", "Não é possível enviar para esta pessoa.");
    }
    if (item.category === "free" && freeClaim?.exists) {
      throw new HttpsError("already-exists", "Sua aliança grátis já foi resgatada.");
    }
    const balance = Number(sender.data()?.[item.currency] ?? 0);
    if (balance < item.cost) {
      throw new HttpsError("failed-precondition", `Saldo insuficiente de ${item.currency === "coins" ? "moedas" : "diamantes"}.`);
    }
    if (item.cost > 0) tx.update(senderRef, { [item.currency]: FieldValue.increment(-item.cost) });
    if (item.category === "free") {
      tx.set(freeClaimRef, { claimedAt: FieldValue.serverTimestamp() });
    }
    tx.set(deliveryRef, {
      fromUid: uid,
      itemType,
      itemName: item.name,
      emoji: item.emoji,
      currency: item.currency,
      cost: item.cost,
      status: "received",
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { success: true, itemName: item.name, status: "received" };
});


/** Report review is intentionally admin-only and should be expanded with moderation workflow. */
export const closeReport = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
  const admin = await db.collection("users").doc(request.auth.uid).get();
  if (admin.data()?.isAdmin !== true) {
    throw new HttpsError("permission-denied", "Acesso restrito.");
  }
  const reportId = String(request.data?.reportId ?? "");
  if (!reportId) throw new HttpsError("invalid-argument", "Denúncia inválida.");
  await db.collection("reports").doc(reportId).update({
    status: "reviewed",
    reviewedAt: FieldValue.serverTimestamp(),
    reviewedBy: request.auth.uid
  });
  return { success: true };
});


// ---------------------------------------------------------------------------
// Moderação de stories: remove automaticamente nudez e conteúdo sexual.
// Fotos: Cloud Vision SafeSearch. Vídeos: Video Intelligence (explicit content).
// Se a análise falhar (API desativada, etc.), o story permanece publicado e o
// erro fica registrado nos logs da função.
// ---------------------------------------------------------------------------
const visionClient = new ImageAnnotatorClient();
const videoClient = new VideoIntelligenceServiceClient();

function isLikely(value: unknown, onlyVeryLikely = false): boolean {
  const v = String(value ?? "");
  if (v === "VERY_LIKELY" || v === "5") return true;
  return !onlyVeryLikely && (v === "LIKELY" || v === "4");
}

function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    const match = new URL(url).pathname.match(/\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) return null;
    return { bucket: match[1], path: decodeURIComponent(match[2]) };
  } catch (_) {
    return null;
  }
}

export const moderateStory = onDocumentCreated(
  { document: "stories/{storyId}", timeoutSeconds: 300, memory: "512MiB" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const story = snap.data();
    const location = parseStorageUrl(String(story.mediaUrl ?? ""));
    if (!location) return;
    const gcsUri = `gs://${location.bucket}/${location.path}`;

    let blocked = false;
    try {
      if (story.mediaType === "video") {
        const [operation] = await videoClient.annotateVideo({
          inputUri: gcsUri,
          features: ["EXPLICIT_CONTENT_DETECTION"]
        });
        const [result] = await operation.promise();
        const frames = result.annotationResults?.[0]?.explicitAnnotation?.frames ?? [];
        blocked = frames.some((frame) => isLikely(frame.pornographyLikelihood));
      } else {
        const [result] = await visionClient.safeSearchDetection({
          image: { source: { imageUri: gcsUri } }
        });
        const safe = result.safeSearchAnnotation;
        blocked = isLikely(safe?.adult) || isLikely(safe?.racy, true);
      }
    } catch (error) {
      console.error("moderateStory: falha ao analisar a mídia", error);
      return;
    }
    if (!blocked) return;

    await snap.ref.delete();
    try {
      await getStorage().bucket(location.bucket).file(location.path).delete();
    } catch (error) {
      console.warn("moderateStory: não foi possível apagar o arquivo", error);
    }
    const ownerId = String(story.ownerId ?? "");
    if (ownerId) {
      await notifyUser(
        ownerId,
        "Story removido",
        "Seu story foi removido por conter nudez ou conteúdo sexual, que não é permitido.",
        { type: "story_removed" }
      );
    }
  }
);



// ---------------------------------------------------------------------------
// Proteção de imagens em mensagens privadas.
// O app faz uma pré-análise antes do upload; este gatilho valida novamente
// toda imagem que chegar ao Firestore. Imagens pendentes nunca são exibidas.
// ---------------------------------------------------------------------------
const privateChatVision = new ImageAnnotatorClient();

function privateImageIsInappropriate(annotation: any): boolean {
  const adult = String(annotation?.adult ?? "");
  const racy = String(annotation?.racy ?? "");
  // SafeSearch: bloqueia conteúdo adulto provável e conteúdo sugestivo muito provável.
  return isLikely(adult) || isLikely(racy, true);
}

export const checkPrivateChatImage = onCall(
  { timeoutSeconds: 60, memory: "512MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta.");
    const chatId = String(request.data?.chatId ?? "");
    const imageBase64 = String(request.data?.imageBase64 ?? "");
    if (!chatId || !imageBase64 || imageBase64.length > 5_600_000) {
      throw new HttpsError("invalid-argument", "Imagem inválida ou maior que o limite permitido.");
    }
    const chat = await db.collection("chats").doc(chatId).get();
    const users = (chat.data()?.users ?? []) as string[];
    if (!chat.exists || !users.includes(request.auth.uid)) {
      throw new HttpsError("permission-denied", "Você não participa desta conversa.");
    }
    const bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) {
      throw new HttpsError("invalid-argument", "A imagem deve ter no máximo 4 MB.");
    }
    try {
      const [result] = await privateChatVision.safeSearchDetection({ image: { content: bytes } });
      const safe = result.safeSearchAnnotation;
      if (privateImageIsInappropriate(safe)) {
        await db.collection("reports").add({
          type: "private_chat_image_blocked",
          chatId,
          senderUid: request.auth.uid,
          categories: { adult: String(safe?.adult ?? "UNKNOWN"), racy: String(safe?.racy ?? "UNKNOWN") },
          status: "open",
          source: "automatic_image_moderation",
          createdAt: FieldValue.serverTimestamp(),
        });
        await notifyUser(request.auth.uid, "Foto bloqueada pelo LoveMix",
          "Uma imagem foi bloqueada pela proteção automática por possível conteúdo íntimo ou sexual.",
          { type: "private_image_blocked", chatId });
        return { allowed: false, reason: "A proteção do LoveMix bloqueou esta imagem por possível conteúdo íntimo ou sexual." };
      }
      return { allowed: true };
    } catch (error) {
      console.error("checkPrivateChatImage: análise indisponível", error);
      // Falha fechada: se não for possível analisar, não liberar o envio.
      throw new HttpsError("unavailable", "Não foi possível verificar a foto com segurança. Tente novamente mais tarde.");
    }
  }
);

export const moderatePrivateChatImage = onDocumentCreated(
  { document: "chats/{chatId}/messages/{messageId}", timeoutSeconds: 120, memory: "512MiB" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const message = snap.data();
    if (message.type !== "image") return;
    const imageUrl = String(message.imageUrl ?? "");
    const senderUid = String(message.senderId ?? "");
    const chatId = event.params.chatId;
    if (!imageUrl || !senderUid) { await snap.ref.delete(); return; }
    try {
      const [result] = await privateChatVision.safeSearchDetection({ image: { source: { imageUri: imageUrl } } });
      const safe = result.safeSearchAnnotation;
      if (privateImageIsInappropriate(safe)) {
        await snap.ref.delete();
        await db.collection("reports").add({
          type: "private_chat_image_blocked",
          chatId,
          senderUid,
          categories: { adult: String(safe?.adult ?? "UNKNOWN"), racy: String(safe?.racy ?? "UNKNOWN") },
          status: "open",
          source: "automatic_image_moderation",
          createdAt: FieldValue.serverTimestamp(),
        });
        await notifyUser(senderUid, "Foto removida do PV",
          "Uma imagem foi removida pela proteção automática do LoveMix por possível conteúdo íntimo ou sexual.",
          { type: "private_image_blocked", chatId });
        return;
      }
      await snap.ref.update({ moderationStatus: "approved", moderatedAt: FieldValue.serverTimestamp() });
      await db.collection("chats").doc(chatId).set({
        lastMessage: "📷 Foto", lastMessageAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error("moderatePrivateChatImage: análise falhou; imagem permanece pendente", error);
      // Não aprovar em caso de falha: a interface oculta mensagens pendentes.
    }
  }
);

/** Mantém na sala quantas pessoas estão dentro agora. A tela inicial usa
 * `voiceLive` para mostrar a sala de voz em "Ao vivo agora" quando tem alguém.
 */
export const syncRoomPresence = onDocumentWritten("rooms/{roomId}/participants/{participantUid}", async (event) => {
  const roomRef = db.collection("rooms").doc(event.params.roomId);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) return;
  const counted = await roomRef.collection("participants").where("isActive", "==", true).count().get();
  const online = counted.data().count;
  const data: any = roomSnap.data() ?? {};
  if (data.onlineCount === online && data.voiceLive === (online > 0)) return;
  await roomRef.update({ onlineCount: online, voiceLive: online > 0 });
});

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN is not set'); process.exit(1); }
if (!BOT_USERNAME) { console.error('BOT_USERNAME is not set'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── File paths ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const QUIZZES_FILE       = path.join(DATA_DIR, 'quizzes.json');
const SESSIONS_FILE      = path.join(DATA_DIR, 'sessions.json');
const GROUP_SESSIONS_FILE = path.join(DATA_DIR, 'group_sessions.json');
const GROUPS_FILE        = path.join(DATA_DIR, 'groups.json'); // tracks groups bot is in

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Storage helpers ──────────────────────────────────────────────────────────
function readJSON(file) {
  try { if (!fs.existsSync(file)) return {}; return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return {}; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('Write error:', e.message); }
}

function getQuizzes()        { return readJSON(QUIZZES_FILE); }
function saveQuizzes(d)      { writeJSON(QUIZZES_FILE, d); }
function getSessions()       { return readJSON(SESSIONS_FILE); }
function saveSessions(d)     { writeJSON(SESSIONS_FILE, d); }
function getGroupSessions()  { return readJSON(GROUP_SESSIONS_FILE); }
function saveGroupSessions(d){ writeJSON(GROUP_SESSIONS_FILE, d); }
function getGroups()         { return readJSON(GROUPS_FILE); }
function saveGroups(d)       { writeJSON(GROUPS_FILE, d); }

// ─── State maps ───────────────────────────────────────────────────────────────
const awaitingQuizInput   = {};  // userId -> true
const awaitingTimerSelect = {};  // userId -> true
const awaitingTimerInput  = {};  // userId -> { quizId }

// In-memory pending lobbies (lost on restart, but that's fine — transient state)
// chatId -> { quizId, initiatorId, joined: { userId: name }, msgId, timeout }
const pendingLobbies = {};

const LOBBY_TIMEOUT_SEC = 90;   // seconds to wait for players
const MIN_PLAYERS       = 3;    // minimum players required

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateId() { return 'quiz_' + Math.random().toString(36).slice(2, 9); }

const NUMERICAL_KEYWORDS = ['calculate','find','₹','amount','value','profit','loss',
  'total','price','cost','rate','percent','percentage','number','how many','how much'];

function isNumerical(q) { return NUMERICAL_KEYWORDS.some(k => q.toLowerCase().includes(k)); }
function getTimer(quiz, q) { return isNumerical(q.question) ? (quiz.numericalTimer || 45) : (quiz.normalTimer || 30); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escMd(t) {
  if (!t) return '';
  return String(t).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function getMedal(i) { return ['🥇', '🥈', '🥉'][i] || `${i + 1}.`; }

// Check if user is admin/creator in a group
async function isGroupAdmin(groupChatId, userId) {
  try {
    const member = await bot.getChatMember(groupChatId, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch { return false; }
}

// Session key uses pipe to avoid split ambiguity with negative chatIds
function sessionKey(chatId, userId) { return `${chatId}|${userId}`; }
function sessionChatId(key) { return key.split('|')[0]; }
function sessionUserId(key) { return key.split('|')[1]; }

// ─── Lobby helpers ────────────────────────────────────────────────────────────
function lobbyText(quiz, lobby) {
  const count    = Object.keys(lobby.joined).length;
  const names    = Object.values(lobby.joined).map(n => `• ${escMd(n)}`).join('\n') || '_No one yet_';
  const needed   = Math.max(0, MIN_PLAYERS - count);
  const status   = count >= MIN_PLAYERS ? '✅ Enough players! Starting soon...' : `⏳ Need ${needed} more player(s) to start`;
  return (
    `🎯 *Quiz Lobby: ${escMd(quiz.topic)}*\n` +
    `${quiz.description ? escMd(quiz.description) + '\n' : ''}` +
    `📊 ${quiz.questions.length} questions\n\n` +
    `👥 *Players joined (${count}/${MIN_PLAYERS}):*\n${names}\n\n` +
    `${status}\n` +
    `🕐 Lobby closes in ${LOBBY_TIMEOUT_SEC}s if not enough players join`
  );
}

function lobbyKeyboard(chatId, isAdmin) {
  const buttons = [
    [{ text: '✋ Join Quiz', callback_data: `join_quiz:${chatId}` }],
  ];
  if (isAdmin) {
    buttons.push([{ text: '🚀 Force Start (Admin)', callback_data: `force_start:${chatId}` }]);
  }
  return { inline_keyboard: buttons };
}

async function startQuizLobby(chatId, quiz, initiatorId, initiatorName, isAdmin) {
  const key = String(chatId);

  // Block if a quiz or lobby is already running
  const groupSessions = getGroupSessions();
  if (groupSessions[key]) {
    return bot.sendMessage(chatId, '⚠️ A quiz is already running in this group. Use /stopquiz to stop it first.');
  }
  if (pendingLobbies[key]) {
    return bot.sendMessage(chatId, '⚠️ A quiz lobby is already open. Please wait or ask an admin to stop it.');
  }

  // Admins bypass lobby and start directly
  if (isAdmin) {
    return startGroupQuiz(chatId, quiz);
  }

  // Create lobby
  const lobby = {
    quizId: quiz.quizId,
    initiatorId,
    joined: { [initiatorId]: initiatorName },
    msgId: null,
    timeout: null,
  };
  pendingLobbies[key] = lobby;

  // Send lobby message (initiator is auto-joined)
  const sent = await bot.sendMessage(chatId, lobbyText(quiz, lobby), {
    parse_mode: 'Markdown',
    reply_markup: lobbyKeyboard(chatId, false),
  });
  lobby.msgId = sent.message_id;

  // Auto-cancel after timeout
  lobby.timeout = setTimeout(async () => {
    if (!pendingLobbies[key]) return;
    const count = Object.keys(pendingLobbies[key].joined).length;
    delete pendingLobbies[key];
    try {
      await bot.editMessageText(
        `❌ Lobby expired — only ${count}/${MIN_PLAYERS} player(s) joined.\nUse /runquiz to try again.`,
        { chat_id: chatId, message_id: sent.message_id, parse_mode: 'Markdown' }
      );
    } catch {}
  }, LOBBY_TIMEOUT_SEC * 1000);
}

// ─── Track groups the bot is in ───────────────────────────────────────────────
function trackGroup(chat) {
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;
  const groups = getGroups();
  groups[String(chat.id)] = { id: chat.id, name: chat.title || 'Unknown Group' };
  saveGroups(groups);
}

// Track when bot is added/removed from a group
bot.on('my_chat_member', (update) => {
  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;
  const status = update.new_chat_member.status;
  const groups = getGroups();
  if (['member', 'administrator'].includes(status)) {
    groups[String(chat.id)] = { id: chat.id, name: chat.title || 'Unknown Group' };
  } else if (['kicked', 'left'].includes(status)) {
    delete groups[String(chat.id)];
  }
  saveGroups(groups);
});

// ─── Main keyboard ────────────────────────────────────────────────────────────
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ['📝 Create Quiz', '📚 Show My Quizzes'],
      ['⏱ Edit Quiz Timer', '🛑 Stop Quiz'],
      ['❓ Help'],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  }
};

const INTRO_IMAGE = path.join(__dirname, 'intro.png');

async function sendMainMenu(chatId) {
  try {
    await bot.sendPhoto(chatId, INTRO_IMAGE, {
      caption:
        '👋 *Welcome to CMA Hustle Quiz Bot!*\n\n' +
        'Create, share & run quizzes — in personal chat or your group.\n\n' +
        '📝 Create Quiz  |  📚 My Quizzes  |  👥 Group Mode',
      parse_mode: 'Markdown',
      ...MAIN_KEYBOARD,
    });
  } catch {
    await bot.sendMessage(chatId, '👋 Welcome to CMA Hustle Quiz Bot! What would you like to do?', MAIN_KEYBOARD);
  }
}

// ─── /start handler ───────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const param   = match[1];
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // Track this group if applicable
  if (isGroup) trackGroup(msg.chat);

  // Clear any pending states
  delete awaitingQuizInput[userId];
  delete awaitingTimerSelect[userId];
  delete awaitingTimerInput[userId];

  if (param) {
    const quizzes = getQuizzes();
    const quiz    = quizzes[param];
    if (!quiz) return bot.sendMessage(chatId, '❌ Quiz not found. It may have been deleted.');

    if (isGroup) {
      // Started via ?startgroup=quizId link in a group
      if (!quiz.questions.length) return bot.sendMessage(chatId, '❌ This quiz has no questions.');
      const isAdmin    = await isGroupAdmin(chatId, userId);
      const name       = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
      return startQuizLobby(chatId, quiz, userId, name, isAdmin);
    }

    // Private chat — show options
    return showQuizOptions(chatId, quiz);
  }

  if (!isGroup) return sendMainMenu(chatId);
});

// Show quiz options: private or group
async function showQuizOptions(chatId, quiz) {
  const groupStartLink = `https://t.me/${BOT_USERNAME}?startgroup=${quiz.quizId}`;
  return bot.sendMessage(chatId,
    `📋 *${escMd(quiz.topic)}*\n${escMd(quiz.description || '')}\n\n📊 *${quiz.questions.length} questions*\n⏱ Timer: Normal ${quiz.normalTimer}s | Numerical ${quiz.numericalTimer}s\n\nChoose how to run this quiz:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 Start in Personal Chat', callback_data: `run_private:${quiz.quizId}` }],
          [{ text: '👥 Pick a Group to Start In', callback_data: `pick_group:${quiz.quizId}` }],
        ]
      }
    }
  );
}

// ─── Text message router (private only) ──────────────────────────────────────
bot.on('message', async (msg) => {
  // Track groups
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    trackGroup(msg.chat);
  }

  if (!msg.text) return;
  if (msg.chat.type !== 'private') return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text.trim();

  if (text.startsWith('/')) return;

  if (awaitingQuizInput[userId]) {
    delete awaitingQuizInput[userId];
    return handleQuizPaste(chatId, userId, text);
  }

  if (awaitingTimerInput[userId]) {
    const { quizId } = awaitingTimerInput[userId];
    delete awaitingTimerInput[userId];
    return handleTimerInput(chatId, userId, quizId, text);
  }

  if (awaitingTimerSelect[userId]) {
    const quizzes     = getQuizzes();
    const userQuizzes = Object.values(quizzes).filter(q => q.userId === userId);
    const selected    = userQuizzes.find((q, i) => text === `${i + 1}. ${q.topic}`);
    if (selected) {
      delete awaitingTimerSelect[userId];
      awaitingTimerInput[userId] = { quizId: selected.quizId };
      return bot.sendMessage(chatId,
        `⏱ Editing timers for *${escMd(selected.topic)}*\n\nCurrent:\nNormal: ${selected.normalTimer}s\nNumerical: ${selected.numericalTimer}s\n\nSend new timers in this format:\n\`Normal: 30\nNumerical: 45\``,
        { parse_mode: 'Markdown' }
      );
    }
    return bot.sendMessage(chatId, '❌ Quiz not found. Please try again.', MAIN_KEYBOARD);
  }

  switch (text) {
    case '📝 Create Quiz':    return handleCreateQuiz(chatId, userId);
    case '📚 Show My Quizzes': return handleShowMyQuizzes(chatId, userId);
    case '⏱ Edit Quiz Timer': return handleEditTimerMenu(chatId, userId);
    case '🛑 Stop Quiz':      return handleStopPrivateQuiz(chatId, userId);
    case '❓ Help':            return handleHelp(chatId);
  }
});

// ─── /runquiz command (group fallback) ───────────────────────────────────────
bot.onText(/\/runquiz(?:\s+(\S+))?/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const quizId  = match[1];
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (isGroup) trackGroup(msg.chat);

  if (!quizId) return bot.sendMessage(chatId, '❌ Usage: /runquiz <quizId>');

  const quizzes = getQuizzes();
  const quiz    = quizzes[quizId];
  if (!quiz) return bot.sendMessage(chatId, '❌ Quiz not found.');
  if (!quiz.questions.length) return bot.sendMessage(chatId, '❌ This quiz has no questions.');

  if (isGroup) {
    const isAdmin = await isGroupAdmin(chatId, userId);
    const name    = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    return startQuizLobby(chatId, quiz, userId, name, isAdmin);
  }

  // Private fallback
  return startGroupQuiz(chatId, quiz);
});

// ─── /stopquiz command (group — admin only) ───────────────────────────────────
bot.onText(/\/stopquiz/, async (msg) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!isGroup) {
    // In private, stop any active session for this user
    return handleStopPrivateQuiz(chatId, userId);
  }

  const admin = await isGroupAdmin(chatId, userId);
  if (!admin) return bot.sendMessage(chatId, '🔒 Only group admins can stop the quiz.');

  const key = String(chatId);

  // Stop pending lobby if exists
  if (pendingLobbies[key]) {
    clearTimeout(pendingLobbies[key].timeout);
    const qName = getQuizzes()[pendingLobbies[key].quizId]?.topic || 'Quiz';
    const msgId = pendingLobbies[key].msgId;
    delete pendingLobbies[key];
    try {
      await bot.editMessageText(`🛑 Lobby for *${escMd(qName)}* was cancelled by an admin.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    } catch {}
    return bot.sendMessage(chatId, `🛑 Quiz lobby cancelled.`);
  }

  const groupSessions = getGroupSessions();
  if (!groupSessions[key]) {
    return bot.sendMessage(chatId, '⚠️ No quiz or lobby is currently running in this group.');
  }

  const quizzes      = getQuizzes();
  const sess         = groupSessions[key];
  const quiz         = quizzes[sess.quizId];
  const quizName     = quiz?.topic || 'Quiz';
  const participants = sess.participants || {};
  delete groupSessions[key];
  saveGroupSessions(groupSessions);

  // Build early leaderboard
  const sorted = Object.values(participants).sort((a, b) => b.correct - a.correct);
  const total  = quiz?.questions?.length || 0;

  let resultText;
  if (!sorted.length) {
    resultText =
      `🛑 *Quiz Stopped: ${escMd(quizName)}*\n\n` +
      `No answers were recorded.\n\n` +
      `Follow: @cma\\_hustle | Instagram: @rishi.\\_.hada`;
  } else {
    const board = sorted.map((p, i) =>
      `${getMedal(i)} ${escMd(p.name)} — ✅ ${p.correct} / ${total}`
    ).join('\n');
    resultText =
      `🛑 *Quiz Stopped Early — ${escMd(quizName)}*\n\n` +
      `🏆 *Current Standings:*\n${board}\n\n` +
      `Follow: @cma\\_hustle | Instagram: @rishi.\\_.hada`;
  }

  return bot.sendMessage(chatId, resultText, { parse_mode: 'Markdown' });
});

// ─── Callback query handler ───────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;

  // ── Join lobby (handle before blanket answer) ────────────────────────────
  if (data.startsWith('join_quiz:')) {
    const groupChatId = data.slice('join_quiz:'.length);
    const lobby = pendingLobbies[groupChatId];
    if (!lobby) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Lobby no longer active.', show_alert: true }).catch(() => {});
    }
    if (lobby.joined[userId]) {
      return bot.answerCallbackQuery(query.id, { text: '✅ You already joined!', show_alert: false }).catch(() => {});
    }

    const name    = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ');
    lobby.joined[userId] = name;

    const quiz    = getQuizzes()[lobby.quizId];
    const count   = Object.keys(lobby.joined).length;
    const isAdmin = await isGroupAdmin(groupChatId, userId);

    // Update lobby message
    try {
      await bot.editMessageText(lobbyText(quiz, lobby), {
        chat_id: groupChatId,
        message_id: lobby.msgId,
        parse_mode: 'Markdown',
        reply_markup: lobbyKeyboard(groupChatId, isAdmin),
      });
    } catch {}

    await bot.answerCallbackQuery(query.id, { text: `✅ You joined! (${count}/${MIN_PLAYERS})`, show_alert: false }).catch(() => {});

    // Auto-start when min players reached
    if (count >= MIN_PLAYERS) {
      clearTimeout(lobby.timeout);
      delete pendingLobbies[groupChatId];
      await sleep(1500);
      return startGroupQuiz(groupChatId, quiz);
    }
    return;
  }

  // ── Force start — admin only (handle before blanket answer) ──────────────
  if (data.startsWith('force_start:')) {
    const groupChatId = data.slice('force_start:'.length);
    const lobby = pendingLobbies[groupChatId];
    if (!lobby) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Lobby no longer active.', show_alert: true }).catch(() => {});
    }

    const isAdmin = await isGroupAdmin(groupChatId, userId);
    if (!isAdmin) {
      return bot.answerCallbackQuery(query.id, { text: '🔒 Only admins can force start.', show_alert: true }).catch(() => {});
    }

    const quiz = getQuizzes()[lobby.quizId];
    clearTimeout(lobby.timeout);
    delete pendingLobbies[groupChatId];

    await bot.answerCallbackQuery(query.id, { text: '🚀 Force starting!', show_alert: false }).catch(() => {});
    return startGroupQuiz(groupChatId, quiz);
  }

  // Blanket answer for all other callbacks
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Run private ──────────────────────────────────────────────────────────
  if (data.startsWith('run_private:')) {
    const quizId = data.slice('run_private:'.length);
    const quiz   = getQuizzes()[quizId];
    if (!quiz) return bot.sendMessage(chatId, '❌ Quiz not found.');
    if (!quiz.questions.length) return bot.sendMessage(chatId, '❌ This quiz has no questions.');
    return startPrivateQuiz(chatId, userId, quiz);
  }

  // ── Pick a group to start in ──────────────────────────────────────────────
  if (data.startsWith('pick_group:')) {
    const quizId = data.slice('pick_group:'.length);
    const groups = getGroups();
    const all    = Object.values(groups);

    if (!all.length) {
      return bot.sendMessage(chatId,
        `📌 Bot hasn't been added to any group yet.\n\nAdd the bot to a group first, then use this button — or use this link to pick a group:\n\`https://t.me/${BOT_USERNAME}?startgroup=${quizId}\``,
        { parse_mode: 'Markdown' }
      );
    }

    // Filter to groups where the requesting user is also a member
    const memberChecks = await Promise.all(
      all.map(async g => {
        try {
          const m = await bot.getChatMember(g.id, userId);
          const ok = ['member', 'administrator', 'creator', 'restricted'].includes(m.status);
          return ok ? g : null;
        } catch { return null; }
      })
    );
    const list = memberChecks.filter(Boolean);

    if (!list.length) {
      return bot.sendMessage(chatId,
        `📌 No common groups found where both you and the bot are members.\n\nAdd the bot to your group first, then try again — or use:\n\`https://t.me/${BOT_USERNAME}?startgroup=${quizId}\``,
        { parse_mode: 'Markdown' }
      );
    }

    // Show groups as buttons (max 8 to stay under callback_data 64-byte limit)
    const buttons = list.slice(0, 8).map(g => {
      return [{ text: `👥 ${g.name}`, callback_data: `sig:${quizId}:${g.id}` }];
    });

    return bot.sendMessage(chatId,
      `👥 *Select a group to start the quiz in:*\n_Showing groups where you and the bot are both members_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  }

  // ── Start in group (sig = start_in_group) ─────────────────────────────────
  if (data.startsWith('sig:')) {
    const parts      = data.split(':');
    const quizId     = parts[1];
    const groupChatId = parts[2];

    const quiz = getQuizzes()[quizId];
    if (!quiz) return bot.sendMessage(chatId, '❌ Quiz not found.');
    if (!quiz.questions.length) return bot.sendMessage(chatId, '❌ This quiz has no questions.');

    // Any member can initiate; admins bypass lobby and start directly
    const isAdmin = await isGroupAdmin(groupChatId, userId);
    const name    = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ');

    await bot.sendMessage(chatId,
      isAdmin
        ? `✅ Starting *${escMd(quiz.topic)}* in the group!`
        : `✅ Lobby opened for *${escMd(quiz.topic)}* — members need to join in the group!`,
      { parse_mode: 'Markdown' }
    );
    return startQuizLobby(groupChatId, quiz, userId, name, isAdmin);
  }

  // ── Quiz info from Show My Quizzes ────────────────────────────────────────
  if (data.startsWith('quiz_info:')) {
    const quizId = data.slice('quiz_info:'.length);
    const quiz   = getQuizzes()[quizId];
    if (!quiz) return bot.sendMessage(chatId, '❌ Quiz not found.');
    return showQuizOptions(chatId, quiz);
  }
});

// ─── MENU HANDLERS ────────────────────────────────────────────────────────────
function handleCreateQuiz(chatId, userId) {
  awaitingQuizInput[userId] = true;
  return bot.sendMessage(chatId,
    `📝 *Create a New Quiz*\n\nSend your quiz in this format:\n\n\`\`\`\nTopic: Your Topic\nDescription: Optional description\n\nQ1. Your question here\nA. Option A\nB. Option B\nC. Option C\nD. Option D\nAnswer: B\n\nQ2. Another question\nA. Option A\nB. Option B\nC. Option C\nD. Option D\nAnswer: A\n\`\`\`\n\nUp to *20 questions*. Answers must be A, B, C, or D.`,
    { parse_mode: 'Markdown' }
  );
}

function handleShowMyQuizzes(chatId, userId) {
  const quizzes     = getQuizzes();
  const userQuizzes = Object.values(quizzes).filter(q => q.userId === userId);

  if (!userQuizzes.length) {
    return bot.sendMessage(chatId, '📭 You have no quizzes yet. Tap *📝 Create Quiz* to make one!', { parse_mode: 'Markdown' });
  }

  // Show each quiz as a clickable button — tapping opens run options
  const keyboard = userQuizzes.map(q => ([
    { text: `📋 ${q.topic} (${q.questions.length}Q)`, callback_data: `quiz_info:${q.quizId}` }
  ]));

  return bot.sendMessage(chatId,
    `📚 *Your Quizzes* — tap one to run it:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

function handleStopPrivateQuiz(chatId, userId) {
  const sessions = getSessions();
  const key = sessionKey(chatId, userId);
  if (!sessions[key]) {
    return bot.sendMessage(chatId, '⚠️ You have no quiz running right now.', MAIN_KEYBOARD);
  }
  const sess     = sessions[key];
  const quizzes  = getQuizzes();
  const quiz     = quizzes[sess.quizId];
  const quizName = quiz?.topic || 'Quiz';
  const total    = quiz?.questions?.length || 0;
  const answered = sess.answered ? sess.currentIndex + 1 : sess.currentIndex;
  const correct  = sess.score || 0;
  const wrong    = answered - correct;

  delete sessions[key];
  saveSessions(sessions);

  return bot.sendMessage(chatId,
    `🛑 *Quiz Stopped: ${escMd(quizName)}*\n\n` +
    `📊 *Your Result:*\n` +
    `✅ Correct: ${correct}\n` +
    `❌ Wrong: ${wrong}\n` +
    `📝 Answered: ${answered} / ${total}\n\n` +
    `Follow: @cma\\_hustle | Instagram: @rishi.\\_.hada`,
    { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
  );
}

function handleEditTimerMenu(chatId, userId) {
  const quizzes     = getQuizzes();
  const userQuizzes = Object.values(quizzes).filter(q => q.userId === userId);
  if (!userQuizzes.length) return bot.sendMessage(chatId, '📭 You have no quizzes to edit.');

  awaitingTimerSelect[userId] = true;
  return bot.sendMessage(chatId, '⏱ Select a quiz to edit its timer:', {
    reply_markup: {
      keyboard: userQuizzes.map((q, i) => [`${i + 1}. ${q.topic}`]),
      resize_keyboard: true,
      one_time_keyboard: true,
    }
  });
}

async function handleTimerInput(chatId, userId, quizId, text) {
  const normalMatch    = text.match(/normal\s*:\s*(\d+)/i);
  const numericalMatch = text.match(/numerical\s*:\s*(\d+)/i);

  if (!normalMatch && !numericalMatch) {
    return bot.sendMessage(chatId, '❌ Invalid format. Send:\n`Normal: 30\nNumerical: 45`', { parse_mode: 'Markdown' });
  }

  const quizzes = getQuizzes();
  if (!quizzes[quizId]) return bot.sendMessage(chatId, '❌ Quiz not found.', MAIN_KEYBOARD);

  if (normalMatch)    quizzes[quizId].normalTimer    = parseInt(normalMatch[1]);
  if (numericalMatch) quizzes[quizId].numericalTimer = parseInt(numericalMatch[1]);
  saveQuizzes(quizzes);

  return bot.sendMessage(chatId,
    `✅ Timers updated!\nNormal: ${quizzes[quizId].normalTimer}s\nNumerical: ${quizzes[quizId].numericalTimer}s`,
    MAIN_KEYBOARD
  );
}

function handleHelp(chatId) {
  return bot.sendMessage(chatId,
    `❓ *Help Guide*\n\n` +
    `*📝 Create Quiz:*\nTap 📝 Create Quiz and paste your quiz in the given format.\n\n` +
    `*📚 Show My Quizzes:*\nTap any quiz to see options — run it privately or in a group.\n\n` +
    `*👤 Personal Mode:*\nEach question appears one at a time. As soon as you answer, the next question comes instantly.\n\n` +
    `*👥 Group Mode:*\n• Tap "Pick a Group to Start In" — bot shows all groups it's in\n• Select your group (you must be admin)\n• Or add bot to group and use: /runquiz <quizId>\n• Each question has a timer; next question shows after timer ends\n• Leaderboard shown at the end\n\n` +
    `*🛑 Stop Quiz:*\n• Private: tap 🛑 Stop Quiz button or use /stopquiz\n• Group: use /stopquiz (admins only)\n\n` +
    `⚠️ *Only admins can start or stop a quiz in a group.*\n\n` +
    `*🔗 Share Link:*\n\`https://t.me/${BOT_USERNAME}?start=<quizId>\`\n\n` +
    `*⏱ Timers:*\nNormal: 30s (default) | Numerical: 45s (default)\nNumerical keywords: calculate, find, ₹, profit, loss, amount...`,
    { parse_mode: 'Markdown' }
  );
}

// ─── QUIZ PARSING ─────────────────────────────────────────────────────────────
async function handleQuizPaste(chatId, userId, text) {
  try {
    const topicMatch = text.match(/^Topic\s*:\s*(.+)/mi);
    const descMatch  = text.match(/^Description\s*:\s*(.+)/mi);

    if (!topicMatch) {
      return bot.sendMessage(chatId, '❌ Could not find "Topic:" in your message. Please follow the format.', MAIN_KEYBOARD);
    }

    const topic       = topicMatch[1].trim();
    const description = descMatch ? descMatch[1].trim() : '';
    const blocks      = text.split(/(?=Q\d+\.)/);
    const questions   = [];

    for (const block of blocks) {
      if (!block.match(/^Q\d+\./)) continue;
      const lines        = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 4) continue;

      const questionLine = lines[0].replace(/^Q\d+\.\s*/, '').trim();
      const options      = {};
      let answer         = null;

      for (const line of lines.slice(1)) {
        const optMatch = line.match(/^([A-D])\.\s*(.+)/i);
        if (optMatch) options[optMatch[1].toUpperCase()] = optMatch[2].trim();
        const ansMatch = line.match(/^Answer\s*:\s*([A-D])/i);
        if (ansMatch) answer = ansMatch[1].toUpperCase();
      }

      if (!questionLine || Object.keys(options).length < 2 || !answer || !options[answer]) continue;

      const optionsArr  = ['A','B','C','D'].map(k => options[k] || '').filter(Boolean);
      const answerIndex = ['A','B','C','D'].indexOf(answer);
      questions.push({ question: questionLine, options: optionsArr, answer: answerIndex });
      if (questions.length >= 20) break;
    }

    if (!questions.length) {
      return bot.sendMessage(chatId, '❌ No valid questions found.\n\nMake sure each block has:\n• Q1. Question\n• A–D options\n• Answer: B', MAIN_KEYBOARD);
    }

    const quizId = generateId();
    const quiz   = { quizId, userId, topic, description, normalTimer: 30, numericalTimer: 45, questions, createdAt: Date.now() };
    const quizzes = getQuizzes();
    quizzes[quizId] = quiz;
    saveQuizzes(quizzes);

    return bot.sendMessage(chatId,
      `✅ *Quiz Saved!*\n\n📋 *${escMd(topic)}*\n${descMatch ? escMd(description) + '\n' : ''}📊 ${questions.length} question(s)\n\n` +
      `🔗 *Share link:*\n\`https://t.me/${BOT_USERNAME}?start=${quizId}\`\n\n` +
      `You can now find it in *📚 Show My Quizzes* to run it.`,
      { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
    );
  } catch (err) {
    console.error('Parse error:', err.message);
    return bot.sendMessage(chatId, '❌ Error parsing quiz. Please check the format and try again.', MAIN_KEYBOARD);
  }
}

// ─── PRIVATE QUIZ MODE ────────────────────────────────────────────────────────
async function startPrivateQuiz(chatId, userId, quiz) {
  const sessions = getSessions();
  const key = sessionKey(chatId, userId);
  sessions[key] = {
    quizId: quiz.quizId,
    currentIndex: 0,
    score: 0,
    answered: false,
    activePollId: null,
  };
  saveSessions(sessions);

  await bot.sendMessage(chatId,
    `🚀 *${escMd(quiz.topic)}* — ${quiz.questions.length} questions\nAnswer each one to move to the next instantly!`,
    { parse_mode: 'Markdown' }
  );
  await sendPrivateQuestion(chatId, userId, quiz, 0);
}

async function sendPrivateQuestion(chatId, userId, quiz, index) {
  const q       = quiz.questions[index];
  const timer   = getTimer(quiz, q);
  const options = q.options.slice();
  while (options.length < 2) options.push('—');

  try {
    const sentPoll = await bot.sendPoll(chatId, q.question, options, {
      type: 'quiz',
      correct_option_id: q.answer,
      is_anonymous: false,
      open_period: timer,
      explanation: `✅ Correct: ${options[q.answer]}`,
    });

    const sessions = getSessions();
    const key = sessionKey(chatId, userId);
    if (sessions[key]) {
      sessions[key].activePollId = sentPoll.poll.id;
      sessions[key].answered = false;
      saveSessions(sessions);
    }

    // Fallback: if user doesn't answer within timer, advance anyway
    setTimeout(() => {
      const s = getSessions();
      if (s[key] && s[key].activePollId === sentPoll.poll.id && !s[key].answered) {
        s[key].answered = true;
        saveSessions(s);
        advancePrivateQuiz(String(chatId), userId);
      }
    }, (timer + 2) * 1000);

  } catch (err) {
    console.error('sendPoll error:', err.message);
    bot.sendMessage(chatId, '❌ Error sending question. Moving to next...');
    advancePrivateQuiz(String(chatId), userId);
  }
}

// ─── poll_answer — handles both private and group answers ─────────────────────
bot.on('poll_answer', async (pollAnswer) => {
  const userId    = pollAnswer.user.id;
  const pollId    = pollAnswer.poll_id;
  const optionIds = pollAnswer.option_ids;

  if (!optionIds || optionIds.length === 0) return;

  // Match private session
  const sessions = getSessions();
  let matchKey = null;
  for (const [key, session] of Object.entries(sessions)) {
    if (session.activePollId === pollId && key.endsWith(`|${userId}`)) {
      matchKey = key;
      break;
    }
  }

  if (matchKey) {
    const session = sessions[matchKey];
    if (session.answered) return; // already counted (timer fallback fired)
    session.answered = true;

    const quiz = getQuizzes()[session.quizId];
    if (!quiz) return;

    const q = quiz.questions[session.currentIndex];
    if (optionIds[0] === q.answer) session.score++;
    saveSessions(sessions);

    const chatId = sessionChatId(matchKey);
    // Immediately advance to next question
    await advancePrivateQuiz(chatId, userId);
    return;
  }

  // Match group session
  const groupSessions = getGroupSessions();
  for (const [chatId, gs] of Object.entries(groupSessions)) {
    if (gs.activePollId !== pollId) continue;

    if (!gs.participants) gs.participants = {};
    const name = [pollAnswer.user.first_name, pollAnswer.user.last_name].filter(Boolean).join(' ');
    if (!gs.participants[userId]) gs.participants[userId] = { name, correct: 0, total: 0 };
    gs.participants[userId].total++;

    const quiz = getQuizzes()[gs.quizId];
    if (quiz) {
      const q = quiz.questions[gs.currentIndex];
      if (optionIds[0] === q.answer) gs.participants[userId].correct++;
    }
    saveGroupSessions(groupSessions);
    break;
  }
});

async function advancePrivateQuiz(chatId, userId) {
  const sessions = getSessions();
  const key      = sessionKey(chatId, userId);
  const session  = sessions[key];
  if (!session) return;

  const quiz = getQuizzes()[session.quizId];
  if (!quiz) { delete sessions[key]; saveSessions(sessions); return; }

  session.currentIndex++;

  if (session.currentIndex >= quiz.questions.length) {
    const score = session.score;
    const total = quiz.questions.length;
    delete sessions[key];
    saveSessions(sessions);
    return bot.sendMessage(chatId,
      `🎯 *Quiz Completed!*\n\nScore: ${score}/${total}\n\nFollow: @cma\\_hustle\nInstagram: @rishi.\\_.hada`,
      { parse_mode: 'Markdown', ...MAIN_KEYBOARD }
    );
  }

  session.answered = false;
  saveSessions(sessions);
  await sendPrivateQuestion(chatId, userId, quiz, session.currentIndex);
}

// ─── GROUP QUIZ MODE ──────────────────────────────────────────────────────────
async function startGroupQuiz(chatId, quiz) {
  const groupSessions = getGroupSessions();
  const key = String(chatId);

  if (groupSessions[key]) {
    return bot.sendMessage(chatId, '⚠️ A quiz is already running in this group. Please wait for it to finish.');
  }

  groupSessions[key] = { quizId: quiz.quizId, currentIndex: 0, participants: {}, activePollId: null };
  saveGroupSessions(groupSessions);

  await bot.sendMessage(chatId,
    `🏁 *Quiz Starting: ${escMd(quiz.topic)}*\n${quiz.description ? escMd(quiz.description) + '\n' : ''}\n📊 ${quiz.questions.length} questions\n\nGet ready! First question in 3 seconds...`,
    { parse_mode: 'Markdown' }
  );
  await sleep(3000);
  await sendGroupQuestion(chatId, quiz, 0);
}

async function sendGroupQuestion(chatId, quiz, index) {
  const groupSessions = getGroupSessions();
  const key = String(chatId);
  const gs  = groupSessions[key];
  if (!gs) return;

  const q       = quiz.questions[index];
  const timer   = getTimer(quiz, q);
  const options = q.options.slice();
  while (options.length < 2) options.push('—');

  try {
    const sentPoll = await bot.sendPoll(chatId, q.question, options, {
      type: 'quiz',
      correct_option_id: q.answer,
      is_anonymous: false,
      open_period: timer,
      explanation: `✅ Correct: ${options[q.answer]}`,
    });

    gs.activePollId = sentPoll.poll.id;
    gs.currentIndex = index;
    saveGroupSessions(groupSessions);

    // Advance after timer expires
    setTimeout(() => advanceGroupQuiz(chatId), (timer + 1) * 1000);

  } catch (err) {
    console.error('Group poll error:', err.message);
    bot.sendMessage(chatId, '❌ Error sending question, skipping...');
    setTimeout(() => advanceGroupQuiz(chatId), 2000);
  }
}

async function advanceGroupQuiz(chatId) {
  const groupSessions = getGroupSessions();
  const key = String(chatId);
  const gs  = groupSessions[key];
  if (!gs) return;

  const quiz = getQuizzes()[gs.quizId];
  if (!quiz) { delete groupSessions[key]; saveGroupSessions(groupSessions); return; }

  const nextIndex = gs.currentIndex + 1;

  if (nextIndex >= quiz.questions.length) {
    const participants = gs.participants || {};
    delete groupSessions[key];
    saveGroupSessions(groupSessions);

    const sorted = Object.values(participants).sort((a, b) => b.correct - a.correct);

    if (!sorted.length) {
      return bot.sendMessage(chatId,
        `🏁 *Quiz Finished: ${escMd(quiz.topic)}*\n\nNo one participated. Better luck next time!`,
        { parse_mode: 'Markdown' }
      );
    }

    const board = sorted.map((p, i) =>
      `${getMedal(i)} ${escMd(p.name)} — ${p.correct}/${quiz.questions.length}`
    ).join('\n');

    return bot.sendMessage(chatId,
      `🏆 *Leaderboard — ${escMd(quiz.topic)}*\n\n${board}\n\nFollow: @cma\\_hustle | Instagram: @rishi.\\_.hada`,
      { parse_mode: 'Markdown' }
    );
  }

  gs.currentIndex = nextIndex;
  saveGroupSessions(groupSessions);
  await sleep(1500);
  await sendGroupQuestion(chatId, quiz, nextIndex);
}

// ─── Error handling ───────────────────────────────────────────────────────────
bot.on('polling_error', (err) => { console.error('Polling error:', err.code, err.message); });
bot.on('error',         (err) => { console.error('Bot error:', err.message); });

// Prevent crashes from blocked users, deleted chats, or any unhandled rejection
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  // Log but do NOT crash — these are usually "bot blocked by user" or "chat not found"
  if (msg.includes('403') || msg.includes('blocked') || msg.includes('chat not found') || msg.includes('400')) {
    console.warn('Ignored Telegram error:', msg.slice(0, 120));
  } else {
    console.error('Unhandled rejection:', msg.slice(0, 300));
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept alive):', err.message);
});

console.log(`✅ Quiz Bot started! @${BOT_USERNAME}`);

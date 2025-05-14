require('dotenv').config();

const { Telegraf } = require('telegraf');
const Stripe = require('stripe');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const apiId = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const botToken = process.env.TG_BOT_TOKEN;
const sessionString = process.env.TG_STRING_SESSION;

if (!apiId || !apiHash || !botToken || !sessionString) {
  throw new Error("❌ Missing required environment variables. Check your .env file.");
}

const stringSession = new StringSession(sessionString);
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const bot = new Telegraf(botToken);
const paidUsers = {};       // MVP only - in-memory storage
const pendingRequests = {}; // chatId -> command mapping

const pricePerSearch = 100; // Stripe amount (100 cents = $1)

async function createCheckoutSession(ctx, command, args) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `TelegramDB ${command} Search` },
        unit_amount: pricePerSearch,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${process.env.SUCCESS_URL}?chat_id=${ctx.chat.id}&command=${command}&args=${encodeURIComponent(args)}`,
    cancel_url: process.env.CANCEL_URL,
  });
  return session.url;
}

const allSupportedCommands = [
  'help', 'credits', 'where', 'near', 'network', 'info',
  'search', 'title', 'group', 'channel', 'bot', 'members',
  'language', 'add', 'faq', 'support', 'stats', 'terms'
];

const paidCommands = ['where', 'near', 'network', 'info', 'members'];

bot.start((ctx) =>
  ctx.reply('Welcome to the TelegramDB Proxy Bot. Use /search, /where, /info, etc.')
);

bot.command((cmd) => true, async (ctx) => {
  const [command, ...args] = ctx.message.text.slice(1).split(' ');
  const argStr = args.join(' ');

  if (!allSupportedCommands.includes(command)) {
    return ctx.reply(`❌ Unknown command: /${command}`);
  }

  if (paidCommands.includes(command) && !paidUsers[ctx.chat.id]) {
    const url = await createCheckoutSession(ctx, command, argStr);
    return ctx.reply(`🔒 This command requires payment. Click to proceed:\n${url}`);
  }

  pendingRequests[ctx.chat.id] = command;

  try {
    await client.sendMessage('tgdb_bot', { message: `/${command} ${argStr}` });
    ctx.reply(`✅ Request sent to /${command}. Please wait...`);
  } catch (err) {
    console.error("❌ Failed to send message:", err);
    ctx.reply("❌ Failed to send request. Please try again later.");
  }
});

client.addEventHandler(async (event) => {
  const message = event.message;
  const sender = await message.getSender();

  if (!sender?.username || sender.username.toLowerCase() !== 'tgdb_bot') {
    return; // Ignore other messages
  }

  console.log(`📨 Message received from @tgdb_bot: ${message.message}`);

  for (const chatId in pendingRequests) {
    await bot.telegram.sendMessage(chatId, `📬 Result from /${pendingRequests[chatId]}:\n\n${message.message}`);
    delete pendingRequests[chatId];
    break;
  }
}, new NewMessage({ incoming: true }));

(async () => {
  console.log("🚀 Connecting Telegram Client...");
  await client.connect();
  console.log("✅ Connected as:", (await client.getMe()).username || "Anonymous");

  console.log("🤖 Launching Telegraf bot...");
  await bot.launch();
})();

// 📁 tgdb-proxy-bot/index.js

require('dotenv').config();

const { Telegraf } = require('telegraf');
const Stripe = require('stripe');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input'); // For initial login only

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const apiId = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const botToken = process.env.TG_BOT_TOKEN;

const stringSession = new StringSession(process.env.TG_STRING_SESSION);
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const bot = new Telegraf(botToken);
const paidUsers = {}; // in-memory DB for MVP
const pendingRequests = {}; // to match responses

const pricePerSearch = 100; // $1 in cents

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

bot.start((ctx) => ctx.reply('Welcome to the TelegramDB Proxy Bot. Use /search, /where, /info, etc.'));

const allSupportedCommands = [
  'help', 'credits', 'where', 'near', 'network', 'info', 'search', 'title', 'group', 'channel', 'bot', 'members',
  'language', 'add', 'faq', 'support', 'stats', 'terms'
];

const paidCommands = ['where', 'near', 'network', 'info', 'members'];

bot.command((cmd) => true, async (ctx) => {
  const [command, ...args] = ctx.message.text.slice(1).split(' ');
  const argStr = args.join(' ');

  if (!allSupportedCommands.includes(command)) {
    return ctx.reply(`❌ Unknown command: /${command}`);
  }

  if (paidCommands.includes(command)) {
    if (!paidUsers[ctx.chat.id]) {
      const url = await createCheckoutSession(ctx, command, argStr);
      return ctx.reply(`🔒 This command requires payment. Click to proceed: ${url}`);
    }
  }

  // Save who made the request
  pendingRequests[ctx.chat.id] = command;

  await client.sendMessage('@tgdb_bot', { message: `/${command} ${argStr}` });
  ctx.reply(`✅ Your request (/` + command + `) was sent. Please wait for the response...`);
});

client.addEventHandler(async (event) => {
  const message = event.message;
  const sender = await message.getSender();
  if (sender && sender.username === 'tgdb_bot') {
    for (const chatId in pendingRequests) {
      bot.telegram.sendMessage(chatId, `📬 Result from /${pendingRequests[chatId]}:

${message.message}`);
      delete pendingRequests[chatId];
      break;
    }
  }
}, new NewMessage({}));

bot.launch();

(async () => {
  console.log('Connecting to Telegram...');
  await client.start({
    phoneNumber: async () => await input.text('Enter your phone number:'),
    password: async () => await input.text('Enter your password:'),
    phoneCode: async () => await input.text('Enter the code you received:'),
    onError: (err) => console.log(err),
  });
  console.log('You are connected as:', await client.getMe());
})();

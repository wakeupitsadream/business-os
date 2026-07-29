#!/usr/bin/env node
/**
 * Генерация OWNER_PASSWORD_HASH (argon2id).
 *
 *   npm run hash:password -- 'мой-пароль'
 *
 * Пароль берём из аргумента, а не из stdin-промпта: так команду видно в
 * истории — но она запускается один раз локально, зато нет риска, что владелец
 * скопирует хэш вместе с невидимым переводом строки.
 */

import { hash, Algorithm } from "@node-rs/argon2";

const password = process.argv[2];

if (!password) {
  console.error("Использование: npm run hash:password -- 'пароль'");
  process.exit(1);
}

if (password.length < 10) {
  console.error("Пароль короче 10 символов — это единственный замок на всей системе.");
  process.exit(1);
}

// Параметры OWASP для argon2id: 19 МиБ памяти, 2 прохода. Проверка занимает
// десятки миллисекунд — на логин это незаметно, перебор дорожает на порядки.
const digest = await hash(password, {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

console.log("");
console.log("Добавьте в окружение (одной строкой, без кавычек вокруг значения в панели):");
console.log("");
console.log(`OWNER_PASSWORD_HASH=${digest}`);
console.log("");

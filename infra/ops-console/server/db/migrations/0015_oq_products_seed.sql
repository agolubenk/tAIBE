-- Продукты очереди v2-lite (план мультипродуктовой очереди, фаза 3). У всех прежних документов и токенов — hr-helper
-- (DEFAULT миграции 0014). Повторный прогон ничего не меняет.
INSERT OR IGNORE INTO `oq_products` (`slug`, `name`) VALUES ('hr-helper', 'HR Helper');--> statement-breakpoint
INSERT OR IGNORE INTO `oq_products` (`slug`, `name`) VALUES ('taibe', 'aiBoards&eval');--> statement-breakpoint
INSERT OR IGNORE INTO `oq_products` (`slug`, `name`) VALUES ('lavaeon', 'Lavaeon');--> statement-breakpoint
-- Токен owner видит все продукты (server/queue/products.ts): строка говорит то же, что делает, — ["*"], а не DEFAULT HR.
UPDATE `oq_tokens` SET `products` = '["*"]' WHERE ',' || `scopes` || ',' LIKE '%,owner,%';

-- Продукты очереди v2-lite (план мультипродуктовой очереди, фаза 3): HR — продукт по умолчанию, у всех прежних
-- документов и токенов он и стоит (DEFAULT миграции 0014). Повторный прогон ничего не меняет.
INSERT OR IGNORE INTO `oq_products` (`slug`, `name`, `is_default`) VALUES ('hr-helper', 'HR Helper', 1);--> statement-breakpoint
INSERT OR IGNORE INTO `oq_products` (`slug`, `name`, `is_default`) VALUES ('taibe', 'aiBoards&eval', 0);--> statement-breakpoint
INSERT OR IGNORE INTO `oq_products` (`slug`, `name`, `is_default`) VALUES ('lavaeon', 'Lavaeon', 0);

-- HR Helper и Lavaeon — один продукт: slug hr-helper, имя «Lavaeon (HR Helper)»; tAIBE — отдельный продукт taibe. Документы,
-- события и токены продукта lavaeon переходят в hr-helper, строка lavaeon уходит из справочника (id «lavaeon-…» — снова
-- пространство HR, products.ts namespaceOf). Повторный прогон ничего не меняет.
-- Старые пункты tAIBE с id без префикса «taibe-» (m-taibe-103) остаются в hr-helper: у MCP очереди один токен (продукт HR,
-- MCP по продуктам — фаза 4a плана), и после переноса сессии tAIBE получали бы 404 на свои пункты. Перенос — по одному,
-- выбором «Продукт:» у пункта, или отдельной миграцией после фазы 4a.
UPDATE `oq_docs` SET `product` = 'hr-helper' WHERE `product` = 'lavaeon';--> statement-breakpoint
UPDATE `oq_events` SET `product` = 'hr-helper' WHERE `product` = 'lavaeon';--> statement-breakpoint
-- Видимость токена: lavaeon → hr-helper без повторов, порядок — по первому вхождению. Не JSON-массив не трогается:
-- tokenVisibility читает его как «ничего не видит», и так остаётся.
UPDATE `oq_tokens` SET `products` = (
  SELECT json_group_array(`p`) FROM (
    SELECT CASE WHEN `value` = 'lavaeon' THEN 'hr-helper' ELSE `value` END AS `p`, min(`key`) AS `k`
    FROM json_each(`oq_tokens`.`products`) GROUP BY `p` ORDER BY `k`
  )
) WHERE `id` IN (
  SELECT `t`.`id` FROM `oq_tokens` AS `t`, json_each(CASE WHEN json_valid(`t`.`products`) THEN CASE WHEN json_type(`t`.`products`) = 'array' THEN `t`.`products` ELSE '[]' END ELSE '[]' END) AS `e`
  WHERE `e`.`value` = 'lavaeon'
);--> statement-breakpoint
DELETE FROM `oq_products` WHERE `slug` = 'lavaeon';--> statement-breakpoint
UPDATE `oq_products` SET `name` = 'Lavaeon (HR Helper)' WHERE `slug` = 'hr-helper';--> statement-breakpoint
UPDATE `oq_products` SET `name` = 'tAIBE' WHERE `slug` = 'taibe';

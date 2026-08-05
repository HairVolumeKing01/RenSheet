-- 迁移: 为 delivered_to 加 UNIQUE 索引 (webhook 幂等)
-- 步骤 1: 同订单号重复交付的记录, 解绑订单号
--         未激活的码回退为 unused (可继续分配), 已激活的不动
-- 步骤 2: 建 UNIQUE 索引
-- 执行: wrangler d1 execute ren sheet-db --remote --file=src/migrate_delivered_unique.sql

UPDATE activation_codes
SET delivered_to = NULL, delivered_at = NULL,
    status = CASE WHEN status = 'delivered' THEN 'unused' ELSE status END
WHERE delivered_to IS NOT NULL AND delivered_to != ''
  AND id NOT IN (
    SELECT MIN(id) FROM activation_codes
    WHERE delivered_to IS NOT NULL AND delivered_to != ''
    GROUP BY delivered_to
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_delivered_to ON activation_codes(delivered_to);

-- 校验: 应无报错, 且以下查询返回 0 行 = 无残留重复
SELECT delivered_to, COUNT(*) AS c FROM activation_codes
WHERE delivered_to IS NOT NULL AND delivered_to != ''
GROUP BY delivered_to HAVING c > 1;

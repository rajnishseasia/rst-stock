ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_max_trade_size_range_check" CHECK ("max_trade_size" IS NULL OR ("max_trade_size" > 0 AND "max_trade_size" <= 1000000));--> statement-breakpoint
ALTER TABLE "copy_trade_follows" ADD CONSTRAINT "copy_trade_follows_max_coin_size_range_check" CHECK ("max_coin_size" IS NULL OR ("max_coin_size" > 0 AND "max_coin_size" <= 1000000));

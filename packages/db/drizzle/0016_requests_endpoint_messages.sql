ALTER TABLE "requests" DROP CONSTRAINT "requests_endpoint";--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_endpoint" CHECK ("requests"."endpoint" IN ('/v1/chat/completions','/v1/responses','/v1/messages'));

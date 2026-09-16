<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // ── FAILED WEBHOOK EVENTS ─────────────────────────────────────────────────
        Schema::create('failed_webhook_events', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('event_id');
            $table->uuid('company_id');
            $table->string('channel_type', 30)->nullable();
            $table->longText('payload')->nullable(); // JSON, stored as text
            $table->longText('error')->nullable();
            $table->unsignedTinyInteger('attempt')->default(1);
            $table->timestamp('created_at')->useCurrent();

            $table->index(['company_id', 'created_at']);
            $table->index('event_id');
        });

        // ── WEBHOOK IDEMPOTENCY EVENTS (SQL fallback for Redis miss) ──────────────
        Schema::create('processed_webhook_events', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('event_id')->unique();
            $table->uuid('company_id');
            $table->string('channel_type', 30);
            $table->timestamp('processed_at')->useCurrent();

            $table->index(['company_id', 'channel_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('processed_webhook_events');
        Schema::dropIfExists('failed_webhook_events');
    }
};

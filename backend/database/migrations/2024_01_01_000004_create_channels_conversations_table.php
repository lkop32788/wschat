<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // ── CHANNELS ─────────────────────────────────────────────────────────────
        Schema::create('channels', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('name', 100);
            $table->string('type', 30); // whatsapp | line | email | telegram | sms | webchat
            $table->string('provider', 50)->nullable();
            $table->text('credentials_encrypted');
            $table->json('settings')->nullable();
            $table->json('failover_channel_ids')->nullable();
            $table->boolean('is_active')->default(true);
            $table->boolean('is_inbox_enabled')->default(true);
            $table->timestamp('last_webhook_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'type', 'is_active']);
        });

        // ── CONVERSATIONS ─────────────────────────────────────────────────────────
        Schema::create('conversations', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->uuid('channel_id');
            $table->uuid('contact_id');
            $table->uuid('assigned_agent_id')->nullable();
            $table->uuid('assigned_team_id')->nullable();
            $table->string('status', 20)->default('pending'); // pending | open | snoozed | resolved | failed_delivery
            $table->string('priority', 10)->default('normal'); // low | normal | high | urgent
            $table->json('intent_tags')->nullable();
            $table->string('subject', 200)->nullable();
            $table->string('last_message_preview', 300)->nullable();
            $table->string('last_message_direction', 10)->nullable(); // inbound | outbound
            $table->timestamp('last_message_at')->nullable();
            $table->timestamp('first_response_at')->nullable();
            $table->timestamp('resolved_at')->nullable();
            $table->timestamp('snoozed_until')->nullable();
            $table->unsignedInteger('message_count')->default(0);
            $table->unsignedInteger('unread_count')->default(0);
            $table->json('custom_attributes')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->foreign('channel_id')->references('id')->on('channels');
            $table->foreign('contact_id')->references('id')->on('contacts');
            $table->foreign('assigned_agent_id')->references('id')->on('users');

            $table->index(['company_id', 'status', 'last_message_at']);
            $table->index(['company_id', 'assigned_agent_id', 'status']);
            $table->index(['company_id', 'contact_id']);
            $table->index(['company_id', 'channel_id', 'status']);
            $table->index(['company_id', 'status', 'first_response_at']);
            $table->index(['status', 'snoozed_until']);
        });

        // ── CONVERSATION ASSIGNMENTS ──────────────────────────────────────────────
        Schema::create('conversation_assignments', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('conversation_id');
            $table->uuid('company_id');
            $table->uuid('assigned_to')->nullable();
            $table->uuid('assigned_by')->nullable();
            $table->string('reason', 50)->nullable(); // auto_dispatch | manual | bot_handoff | reassign
            $table->timestamp('created_at');

            $table->index(['conversation_id', 'created_at']);
            $table->index(['company_id', 'assigned_to', 'created_at']);
        });

        // ── CONVERSATION FAILOVER LOG ─────────────────────────────────────────────
        Schema::create('conversation_failover_log', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('conversation_id');
            $table->uuid('company_id');
            $table->uuid('attempted_channel_id');
            $table->string('status', 20); // success | failed
            $table->string('error_code', 50)->nullable();
            $table->string('error_message', 500)->nullable();
            $table->timestamp('created_at');

            $table->index(['conversation_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversation_failover_log');
        Schema::dropIfExists('conversation_assignments');
        Schema::dropIfExists('conversations');
        Schema::dropIfExists('channels');
    }
};

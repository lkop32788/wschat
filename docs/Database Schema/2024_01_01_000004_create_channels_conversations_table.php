<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * KEPUTUSAN ARSITEKTUR: channels vs conversations
 *
 * `channels` = konfigurasi koneksi ke provider (satu WhatsApp BSP account, satu LINE Bot, dst).
 *   - Credential (API key, token) disimpan encrypted.
 *   - Satu company bisa punya multiple channel dari tipe yang sama.
 *   - Contoh: company memiliki 2 nomor WhatsApp (untuk Sales dan Support).
 *
 * `conversations` = satu sesi percakapan antara SATU contact dan SATU channel.
 *   - Tabel ini hanya menyimpan HEADER/METADATA percakapan.
 *   - Isi pesan (chat messages) disimpan di MongoDB.
 *   - Ini memungkinkan query cepat di SQL (filter by status, assignee) tanpa
 *     harus menyentuh MongoDB untuk list view di inbox.
 *
 * STATUS FLOW:
 *   pending → open → (resolved | snoozed)
 *                      resolved → (dapat di-reopen)
 *                      snoozed  → open (saat snooze timer habis)
 */
return new class extends Migration
{
    public function up(): void
    {
        // ── CHANNELS ────────────────────────────────────────────────────────────
        Schema::create('channels', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('name', 100);                       // "WA Support", "LINE Sales"
            $table->string('type', 30);                        // whatsapp | line | email | telegram | sms | webchat
            $table->string('provider', 50)->nullable();        // twilio | 360dialog | fonnte | tyntec
            $table->text('credentials_encrypted');             // AES-256-CBC, key dari config/env
            $table->json('settings')->nullable();              // webhook_url, phone_number, email_address, etc.
            $table->json('failover_channel_ids')->nullable();  // [uuid, uuid] — ordered fallback list
            $table->boolean('is_active')->default(true);
            $table->boolean('is_inbox_enabled')->default(true);
            $table->timestamp('last_webhook_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'type', 'is_active']);
        });

        // ── CONVERSATIONS ────────────────────────────────────────────────────────
        Schema::create('conversations', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->uuid('channel_id');
            $table->uuid('contact_id');
            $table->uuid('assigned_agent_id')->nullable();
            $table->uuid('assigned_team_id')->nullable();
            $table->string('status', 20)->default('pending'); // pending | open | snoozed | resolved
            $table->string('priority', 10)->default('normal'); // low | normal | high | urgent
            $table->json('intent_tags')->nullable();           // ["billing", "complaint"] — hasil analisis
            $table->string('subject', 200)->nullable();        // untuk email channel
            $table->string('last_message_preview', 300)->nullable(); // untuk inbox list view
            $table->string('last_message_direction', 10)->nullable(); // inbound | outbound
            $table->timestamp('last_message_at')->nullable();
            $table->timestamp('first_response_at')->nullable(); // untuk SLA tracking
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

            // CRITICAL INDEXES: Semua query inbox pasti filter by company + status
            $table->index(['company_id', 'status', 'last_message_at']);
            $table->index(['company_id', 'assigned_agent_id', 'status']);
            $table->index(['company_id', 'contact_id']);
            $table->index(['company_id', 'channel_id', 'status']);
            // Untuk SLA monitoring
            $table->index(['company_id', 'status', 'first_response_at']);
            // Untuk snooze wakeup job
            $table->index(['status', 'snoozed_until']);
        });

        // Assignment history — untuk audit & supervisor tracking
        Schema::create('conversation_assignments', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('conversation_id');
            $table->uuid('company_id');
            $table->uuid('assigned_to')->nullable();           // null = unassigned
            $table->uuid('assigned_by')->nullable();           // null = auto-dispatch
            $table->string('reason', 50)->nullable();          // auto_dispatch | manual | bot_handoff | reassign
            $table->timestamp('created_at');

            $table->index(['conversation_id', 'created_at']);
            $table->index(['company_id', 'assigned_to', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversation_assignments');
        Schema::dropIfExists('conversations');
        Schema::dropIfExists('channels');
    }
};

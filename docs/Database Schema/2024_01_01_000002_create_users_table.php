<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * KEPUTUSAN ARSITEKTUR: users = agen + admin, bukan end-customer
 *
 * "Users" di sini adalah internal operator platform (CS agent, supervisor, admin).
 * End-customer disimpan di tabel `contacts` secara terpisah karena:
 * 1. Contacts tidak punya credentials (tidak login ke dashboard)
 * 2. Contacts bisa duplikat cross-channel sebelum di-merge
 * 3. Volume contacts bisa 100x lebih besar dari agents
 *
 * SKILLS: disimpan sebagai JSON array di kolom `skill_tags`.
 * Alternatif: tabel pivot users_skills — tapi untuk query Redis-based dispatcher
 * yang membaca dari in-memory, JSON column lebih cepat di-load ke cache.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('name', 100);
            $table->string('email', 150);
            $table->string('password');
            $table->string('role', 30)->default('agent');     // super_admin | admin | supervisor | agent
            $table->json('skill_tags')->nullable();            // ["billing", "technical", "general"]
            $table->unsignedSmallInteger('max_concurrent_chats')->default(5);
            $table->string('avatar_url', 500)->nullable();
            $table->string('locale', 10)->default('id');
            $table->string('timezone', 50)->default('Asia/Jakarta');
            $table->boolean('is_active')->default(true);
            $table->timestamp('last_seen_at')->nullable();
            $table->rememberToken();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');

            // CRITICAL: email unique per company, bukan global
            // Agent dari company A dan B boleh pakai email yang sama
            $table->unique(['company_id', 'email']);
            $table->index(['company_id', 'role', 'is_active']);
        });

        // Audit trail untuk perubahan role & akses sensitif
        Schema::create('user_audit_logs', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('company_id');
            $table->uuid('actor_id');                          // siapa yang melakukan
            $table->uuid('target_user_id');                    // siapa yang diubah
            $table->string('action', 50);                      // role_changed | deactivated | password_reset
            $table->json('before')->nullable();
            $table->json('after')->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->timestamp('created_at');

            $table->index(['company_id', 'target_user_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_audit_logs');
        Schema::dropIfExists('users');
    }
};

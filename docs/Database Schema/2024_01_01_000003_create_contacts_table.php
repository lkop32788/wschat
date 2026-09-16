<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * KEPUTUSAN ARSITEKTUR: Contact Identity Resolution
 *
 * Satu pelanggan nyata bisa masuk dari beberapa channel dengan identifier berbeda:
 * - WhatsApp: +6281234567890
 * - LINE:     Ud1f3a2b9c...
 * - Email:    budi@gmail.com
 *
 * Solusi: tabel `contacts` = master record (golden record).
 *         tabel `contact_channel_identities` = mapping per channel.
 *
 * Saat pesan masuk dari channel, kita PERTAMA cari di contact_channel_identities.
 * Jika ditemukan → link ke contact yang sudah ada.
 * Jika tidak → buat contact baru + identity baru.
 *
 * Merge: saat agen confirm dua contact adalah orang yang sama,
 * update semua identity ke contact_id yang "menang", soft-delete yang "kalah".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('contacts', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('name', 150)->nullable();
            $table->string('email', 150)->nullable();
            $table->string('phone', 30)->nullable();
            $table->string('avatar_url', 500)->nullable();
            $table->string('locale', 10)->nullable();
            $table->string('timezone', 50)->nullable();
            $table->json('custom_attributes')->nullable();      // CRM fields per company
            $table->json('tags')->nullable();                   // ["vip", "high-risk"]
            $table->unsignedBigInteger('lifetime_conversation_count')->default(0);
            $table->timestamp('last_contacted_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'email']);
            $table->index(['company_id', 'phone']);
            $table->index(['company_id', 'last_contacted_at']);
        });

        Schema::create('contact_channel_identities', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->uuid('contact_id');
            $table->uuid('company_id');
            $table->string('channel_type', 30);                // whatsapp | line | email | telegram | sms
            $table->string('external_id', 200);                // identifier dari provider (nomor WA, LINE UID, dll)
            $table->string('display_name', 150)->nullable();   // nama dari profile provider
            $table->string('avatar_url', 500)->nullable();
            $table->json('raw_profile')->nullable();            // raw data dari provider untuk referensi
            $table->timestamps();

            $table->foreign('contact_id')->references('id')->on('contacts');

            // CRITICAL: satu external_id per channel per company — tidak boleh duplikat
            $table->unique(['company_id', 'channel_type', 'external_id']);
            $table->index(['contact_id', 'channel_type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('contact_channel_identities');
        Schema::dropIfExists('contacts');
    }
};

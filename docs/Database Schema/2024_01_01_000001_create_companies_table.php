<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * KEPUTUSAN ARSITEKTUR: companies = root tenant
 *
 * Setiap company adalah satu tenant terisolasi. Semua tabel downstream
 * wajib memiliki kolom company_id sebagai partition key. Ini penting untuk:
 * 1. Row-level security di SQL Server
 * 2. Sharding di masa depan jika satu company volume-nya masif
 * 3. Memudahkan hard-delete satu tenant tanpa cascade error
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('companies', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('name', 100);
            $table->string('slug', 80)->unique();              // subdomain / identifier unik
            $table->string('timezone', 50)->default('UTC');
            $table->string('locale', 10)->default('id');
            $table->string('plan', 30)->default('starter');   // starter | pro | enterprise
            $table->unsignedInteger('max_agents')->default(5);
            $table->unsignedInteger('max_channels')->default(3);
            $table->boolean('is_active')->default(true);
            $table->json('feature_flags')->nullable();         // kill-switch per feature per tenant
            $table->json('settings')->nullable();              // misc config tanpa tambah kolom
            $table->timestamp('trial_ends_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            // Index untuk lookup tenant dari subdomain / slug
            $table->index('slug');
            $table->index(['is_active', 'plan']);
        });

        // Tabel untuk billing / subscription — dipisah agar companies tetap lean
        Schema::create('company_subscriptions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('provider', 30);                   // midtrans | xendit | stripe
            $table->string('external_subscription_id', 100)->nullable();
            $table->string('status', 20);                     // active | past_due | canceled
            $table->decimal('monthly_amount', 12, 2);
            $table->string('currency', 3)->default('IDR');
            $table->timestamp('current_period_start');
            $table->timestamp('current_period_end');
            $table->timestamps();

            $table->foreign('company_id')->references('id')->on('companies');
            $table->index(['company_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('company_subscriptions');
        Schema::dropIfExists('companies');
    }
};

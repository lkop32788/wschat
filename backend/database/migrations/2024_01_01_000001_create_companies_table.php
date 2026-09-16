<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('companies', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('name', 100);
            $table->string('slug', 80)->unique();
            $table->string('timezone', 50)->default('UTC');
            $table->string('locale', 10)->default('id');
            $table->string('plan', 30)->default('starter');
            $table->unsignedInteger('max_agents')->default(5);
            $table->unsignedInteger('max_channels')->default(3);
            $table->boolean('is_active')->default(true);
            $table->json('feature_flags')->nullable();
            $table->json('settings')->nullable();
            $table->timestamp('trial_ends_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index('slug');
            $table->index(['is_active', 'plan']);
        });

        Schema::create('company_subscriptions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('company_id');
            $table->string('provider', 30);
            $table->string('external_subscription_id', 100)->nullable();
            $table->string('status', 20);
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

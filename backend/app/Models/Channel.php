<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Facades\Crypt;

class Channel extends Model
{
    use BelongsToTenant, HasUuids, SoftDeletes;

    protected $fillable = [
        'company_id',
        'name',
        'type',
        'provider',
        'credentials_encrypted',
        'settings',
        'failover_channel_ids',
        'is_active',
        'is_inbox_enabled',
        'last_webhook_at',
    ];

    protected $casts = [
        'settings'            => 'array',
        'failover_channel_ids' => 'array',
        'is_active'           => 'boolean',
        'is_inbox_enabled'    => 'boolean',
        'last_webhook_at'     => 'datetime',
    ];

    protected $hidden = ['credentials_encrypted'];

    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    public function conversations(): HasMany
    {
        return $this->hasMany(Conversation::class);
    }

    public function getCredentials(): array
    {
        return json_decode(Crypt::decryptString($this->credentials_encrypted), true);
    }

    public function setCredentials(array $credentials): void
    {
        $this->credentials_encrypted = Crypt::encryptString(json_encode($credentials));
    }

    public function getRateLimit(): int
    {
        return $this->settings['rate_limit']['messages_per_minute'] ?? 30;
    }
}

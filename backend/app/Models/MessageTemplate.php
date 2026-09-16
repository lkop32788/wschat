<?php

namespace App\Models;

use App\Models\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class MessageTemplate extends Model
{
    use HasUuids, BelongsToTenant;

    protected $fillable = [
        'company_id', 'channel_id', 'name', 'channel_type', 'category',
        'language', 'status', 'wa_template_name', 'wa_template_id',
        'components', 'variables_schema', 'preview_text', 'rejection_reason',
    ];

    protected $casts = [
        'components'       => 'array',
        'variables_schema' => 'array',
    ];

    /** Render template body with recipient variables. */
    public function render(array $variables): string
    {
        $components = $this->components;
        $body = collect($components)->firstWhere('type', 'body')['text'] ?? '';

        $schema = $this->variables_schema ?? [];
        foreach ($schema as $def) {
            $pos   = $def['position'];
            $key   = $def['key'];
            $value = $variables[$key] ?? '';
            $body  = str_replace("{{{$pos}}}", $value, $body);
        }

        return $body;
    }
}

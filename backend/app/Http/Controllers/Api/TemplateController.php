<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\MessageTemplate;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

class TemplateController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $templates = MessageTemplate::where('company_id', $request->user()->company_id)
            ->when($request->channel_type, fn ($q, $t) => $q->where('channel_type', $t))
            ->when($request->status, fn ($q, $s) => $q->where('status', $s))
            ->orderByDesc('created_at')
            ->get();

        return response()->json($templates);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name'             => 'required|string|max:100',
            'channel_id'       => 'nullable|uuid',
            'channel_type'     => 'required|string|max:30',
            'category'         => 'nullable|string|max:50',
            'language'         => 'nullable|string|max:10',
            'wa_template_name' => 'nullable|string|max:100',
            'components'       => 'required|array',
            'variables_schema' => 'nullable|array',
            'preview_text'     => 'nullable|string',
        ]);

        $template = MessageTemplate::create([
            ...$data,
            'company_id' => $request->user()->company_id,
            'status'     => 'pending',
        ]);

        // For WhatsApp: submit to Meta Graph API (async — fires and forgets)
        if ($data['channel_type'] === 'whatsapp' && $data['wa_template_name'] ?? null) {
            $this->submitToMeta($template);
        } else {
            $template->update(['status' => 'approved']);
        }

        return response()->json($template, 201);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $template = MessageTemplate::where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        return response()->json($template);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        MessageTemplate::where('company_id', $request->user()->company_id)
            ->findOrFail($id)
            ->delete();

        return response()->json(['message' => 'deleted']);
    }

    /** Webhook from Meta for template status update. */
    public function metaWebhook(Request $request): JsonResponse
    {
        $entry     = $request->input('entry.0');
        $changes   = $entry['changes'][0]['value'] ?? null;

        if (! $changes || ($changes['event'] ?? '') !== 'APPROVED') {
            $template = MessageTemplate::where('wa_template_id', $changes['message_template_id'] ?? '')
                ->first();

            if ($template) {
                $template->update([
                    'status'           => strtolower($changes['event'] ?? 'pending'),
                    'rejection_reason' => $changes['reason'] ?? null,
                ]);
            }
        }

        return response()->json(['ok' => true]);
    }

    private function submitToMeta(MessageTemplate $template): void
    {
        // Fire and forget — Meta webhook will update status
        try {
            $channel = \App\Models\Channel::find($template->channel_id);
            if (! $channel) {
                return;
            }
            $credentials = json_decode(\Illuminate\Support\Facades\Crypt::decryptString(
                $channel->credentials_encrypted
            ), true);

            Http::withToken($credentials['access_token'] ?? '')
                ->post("https://graph.facebook.com/v19.0/{$credentials['phone_number_id']}/message_templates", [
                    'name'       => $template->wa_template_name,
                    'category'   => strtoupper($template->category ?? 'UTILITY'),
                    'language'   => $template->language,
                    'components' => $template->components,
                ]);
        } catch (\Throwable) {
            // Non-fatal — status stays pending until Meta webhook arrives
        }
    }
}

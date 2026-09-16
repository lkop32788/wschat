<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Contact;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ContactController extends Controller
{
    /**
     * GET /api/contacts/{id}
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $contact = Contact::with('channelIdentities')
            ->where('company_id', $request->user()->company_id)
            ->findOrFail($id);

        return response()->json($this->format($contact));
    }

    /**
     * PATCH /api/contacts/{id}
     * Hanya field yang aman untuk diupdate oleh agent.
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $contact = Contact::where('company_id', $request->user()->company_id)->findOrFail($id);

        $validated = $request->validate([
            'name'              => 'sometimes|string|max:255',
            'email'             => 'sometimes|nullable|email|max:255',
            'phone'             => 'sometimes|nullable|string|max:30',
            'locale'            => 'sometimes|nullable|string|max:10',
            'timezone'          => 'sometimes|nullable|string|max:50',
            'custom_attributes' => 'sometimes|array',
            'tags'              => 'sometimes|array',
            'tags.*'            => 'string|max:50',
        ]);

        // Jika nama diupdate, tandai sebagai manual
        if (isset($validated['name'])) {
            $validated['name_is_manual'] = true;
        }

        $contact->update($validated);

        return response()->json($this->format($contact->fresh('channelIdentities')));
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function format(Contact $c): array
    {
        return [
            'id'               => $c->id,
            'name'             => $c->name,
            'name_is_manual'   => $c->name_is_manual,
            'email'            => $c->email,
            'phone'            => $c->phone,
            'avatar_url'       => $c->avatar_url,
            'locale'           => $c->locale,
            'timezone'         => $c->timezone,
            'tags'             => $c->tags ?? [],
            'custom_attributes' => $c->custom_attributes ?? [],
            'lifetime_conversation_count' => $c->lifetime_conversation_count,
            'last_contacted_at' => $c->last_contacted_at?->toISOString(),
            'channel_identities' => $c->channelIdentities->map(fn($i) => [
                'channel_type' => $i->channel_type,
                'external_id'  => $i->external_id,
                'display_name' => $i->display_name,
            ]),
        ];
    }
}

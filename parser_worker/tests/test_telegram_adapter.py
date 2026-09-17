import unittest
import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

from telethon.tl import functions, types
from telethon.errors import FloodWaitError

from parser_worker.telegram_adapter import TelethonAdapter, normalize_group, telegram_error_code
from parser_worker.service import FloodWait


class Entity:
    def __init__(self, **values):
        self.__dict__.update(values)


class TelegramAdapterTests(unittest.TestCase):
    def test_normalizes_supergroups_channels_and_basic_groups_without_mixing_types(self):
        supergroup = normalize_group(Entity(id=10, title="Founders", username="founders", megagroup=True,
                                            broadcast=False, participants_count=1200, access_hash=99), marked_id=-10010)
        channel = normalize_group(Entity(id=11, title="News", username="news", megagroup=False,
                                         broadcast=True, participants_count=5000, access_hash=98), marked_id=-10011)
        group = normalize_group(Entity(id=12, title="Small chat", participants_count=50), marked_id=-12)

        self.assertEqual(supergroup["type"], "supergroup")
        self.assertEqual(channel["type"], "channel")
        self.assertEqual(group["type"], "group")
        self.assertEqual(supergroup["accessHash"], "99")

    def test_maps_known_join_failures_without_retrying_unknown_forever(self):
        cases = {
            "ChannelPrivateError": "PRIVATE", "UserBannedInChannelError": "BANNED",
            "ChannelsTooMuchError": "LIMIT_REACHED", "UsernameNotOccupiedError": "UNAVAILABLE",
            "UserAlreadyParticipantError": "ALREADY_JOINED", "SomethingUnexpected": "RETRYABLE",
        }
        for error_name, expected in cases.items():
            error = type(error_name, (Exception,), {})()
            self.assertEqual(telegram_error_code(error), expected)

    def test_message_payload_keeps_history_message_when_optional_metadata_is_unavailable(self):
        class UnreadableMetadataMessage:
            chat_id = -100700
            id = 42
            raw_text = "We need a website for our business."
            date = datetime(2026, 8, 27, 14, 36, tzinfo=UTC)

            async def get_chat(self):
                raise RuntimeError("chat metadata unavailable")

            async def get_sender(self):
                raise RuntimeError("sender metadata unavailable")

        payload = asyncio.run(TelethonAdapter()._message_payload(UnreadableMetadataMessage()))

        self.assertEqual(payload["telegramGroupId"], "-100700")
        self.assertEqual(payload["messageId"], 42)
        self.assertEqual(payload["messageText"], "We need a website for our business.")
        self.assertIsNone(payload["authorId"])
        self.assertIsNone(payload["groupTitle"])

    def test_history_skips_service_messages_with_null_raw_text(self):
        class HistoryClient:
            def is_connected(self):
                return True

            async def iter_messages(self, _entity, offset_date):
                yield SimpleNamespace(
                    id=1, chat_id=-100701, raw_text=None, out=False,
                    date=datetime(2026, 8, 27, 14, 36, tzinfo=UTC),
                )

        adapter = TelethonAdapter()
        adapter.client = HistoryClient()

        async def collect():
            return [message async for message in adapter.iter_group_messages(
                {"username": "history_group"},
                after="2026-08-27T14:35:00Z", before="2026-08-27T14:37:00Z",
            )]

        self.assertEqual(asyncio.run(collect()), [])

    def test_message_payload_uses_caption_and_marks_media_without_textual_content(self):
        class CaptionMessage:
            chat_id = -100702
            id = 43
            raw_text = ""
            message = ""
            text = ""
            caption = "Looking for a Django developer, remote."
            media = object()
            date = datetime(2026, 8, 27, 14, 36, tzinfo=UTC)

            async def get_chat(self):
                return SimpleNamespace(title="Caption group", username="caption_group")

            async def get_sender(self):
                return None

        class MediaOnlyMessage(CaptionMessage):
            id = 44
            caption = ""

        caption = asyncio.run(TelethonAdapter()._message_payload(CaptionMessage()))
        media_only = asyncio.run(TelethonAdapter()._message_payload(MediaOnlyMessage()))

        self.assertEqual(caption["messageText"], "Looking for a Django developer, remote.")
        self.assertEqual(caption["contentType"], "caption")
        self.assertEqual(media_only["messageText"], "")
        self.assertEqual(media_only["contentType"], "media_without_text")


class FakeConnectedClient:
    def __init__(self):
        self.requests = []
        self.filters = []
        self.folder_ids = {}

    def is_connected(self):
        return True

    async def get_input_entity(self, reference):
        return types.InputPeerChannel(channel_id=123, access_hash=456)

    async def __call__(self, request):
        self.requests.append(request)
        if isinstance(request, functions.messages.GetDialogFiltersRequest):
            return self.filters
        if isinstance(request, functions.messages.UpdateDialogFilterRequest):
            if request.filter is not None and request.filter not in self.filters:
                self.filters.append(request.filter)
            return True
        if isinstance(request, functions.messages.GetPeerDialogsRequest):
            dialogs = []
            for item in request.peers:
                channel_id = item.peer.channel_id
                dialogs.append(SimpleNamespace(peer=SimpleNamespace(channel_id=channel_id), folder_id=self.folder_ids.get(channel_id)))
            return SimpleNamespace(dialogs=dialogs)
        if isinstance(request, functions.folders.EditPeerFoldersRequest):
            for item in request.folder_peers:
                self.folder_ids[item.peer.channel_id] = item.folder_id
            return []
        raise AssertionError(type(request).__name__)


class TelethonAdapterGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_folder_and_archive_gateway_reuses_connected_client(self):
        adapter = TelethonAdapter()
        client = FakeConnectedClient()
        adapter.client = client
        group = {"telegramGroupId": "-100123", "accessHash": "456", "type": "supergroup"}

        resolved = await adapter.resolve_input_peer(group)
        created = await adapter.create_dialog_filter("парсер", [resolved])
        filters = await adapter.get_dialog_filters()
        await adapter.update_dialog_filter(created.id, created)
        before = await adapter.get_peer_folder_ids([resolved])
        await adapter.archive_peers([resolved])
        after = await adapter.get_peer_folder_ids([resolved])

        self.assertIs(adapter.client, client)
        self.assertEqual(created.title.text, "парсер")
        self.assertFalse(created.exclude_archived)
        self.assertFalse(created.groups)
        self.assertEqual(filters, [created])
        self.assertIsNone(before[("channel", 123)])
        self.assertEqual(after[("channel", 123)], 1)
        archive_request = next(item for item in client.requests if isinstance(item, functions.folders.EditPeerFoldersRequest))
        self.assertEqual(archive_request.folder_peers[0].folder_id, 1)

    async def test_create_filter_uses_an_unused_id_and_does_not_call_chatlist_invite_apis(self):
        adapter = TelethonAdapter()
        client = FakeConnectedClient()
        client.filters = [SimpleNamespace(id=2, title="Работа")]
        adapter.client = client
        input_peer = types.InputPeerChannel(channel_id=123, access_hash=456)

        created = await adapter.create_dialog_filter("парсер", [input_peer])

        self.assertEqual(created.id, 3)
        self.assertEqual([type(item).__name__ for item in client.requests], [
            "GetDialogFiltersRequest", "UpdateDialogFilterRequest",
        ])

    async def test_folder_flood_wait_preserves_exact_server_duration(self):
        adapter = TelethonAdapter()
        class FloodClient(FakeConnectedClient):
            async def __call__(self, request):
                raise FloodWaitError(request=None, capture=37)

        client = FloodClient()
        adapter.client = client

        with self.assertRaises(FloodWait) as raised:
            await adapter.get_dialog_filters()

        self.assertEqual(raised.exception.seconds, 37)

    async def test_get_dialog_filters_accepts_telethon_dialog_filters_wrapper(self):
        adapter = TelethonAdapter()
        folder = types.DialogFilter(
            id=7, title=types.TextWithEntities(text="парсер", entities=[]),
            pinned_peers=[], include_peers=[], exclude_peers=[], exclude_archived=False,
        )

        class WrappedClient(FakeConnectedClient):
            async def __call__(self, request):
                if isinstance(request, functions.messages.GetDialogFiltersRequest):
                    return types.messages.DialogFilters(filters=[folder], tags_enabled=True)
                return await super().__call__(request)

        adapter.client = WrappedClient()

        result = await adapter.get_dialog_filters()

        self.assertEqual(result, [folder])


if __name__ == "__main__":
    unittest.main()

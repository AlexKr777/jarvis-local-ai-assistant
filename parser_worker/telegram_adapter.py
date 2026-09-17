from __future__ import annotations

import asyncio
import inspect
from datetime import UTC, datetime
from typing import Any, Awaitable, Callable

try:
    from telethon import TelegramClient, events, functions, utils
    from telethon.errors import FloodWaitError, SessionPasswordNeededError
    from telethon.sessions import StringSession
    from telethon.tl import types as tl_types
    from telethon.tl.types import InputChannel

    TELETHON_AVAILABLE = True
except ImportError:  # The worker remains healthy and reports the missing optional dependency.
    TelegramClient = None
    events = functions = utils = StringSession = InputChannel = tl_types = None
    FloodWaitError = SessionPasswordNeededError = Exception
    TELETHON_AVAILABLE = False


class TelegramOperationError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def telegram_error_code(error: BaseException) -> str:
    name = type(error).__name__
    known = {
        "ChannelPrivateError": "PRIVATE",
        "ChatAdminRequiredError": "PRIVATE",
        "UserBannedInChannelError": "BANNED",
        "ChannelsTooMuchError": "LIMIT_REACHED",
        "UsernameNotOccupiedError": "UNAVAILABLE",
        "UsernameInvalidError": "UNAVAILABLE",
        "ChannelInvalidError": "UNAVAILABLE",
        "ChannelPublicGroupNaError": "UNAVAILABLE",
        "ChannelDeletedError": "DELETED",
        "UserAlreadyParticipantError": "ALREADY_JOINED",
    }
    return known.get(name, "RETRYABLE")


def normalize_group(entity: Any, *, marked_id: int | None = None) -> dict[str, Any]:
    entity_id = int(getattr(entity, "id", 0) or 0)
    is_broadcast = bool(getattr(entity, "broadcast", False))
    is_megagroup = bool(getattr(entity, "megagroup", False))
    group_type = "channel" if is_broadcast else "supergroup" if is_megagroup else "group"
    peer_id = marked_id
    if peer_id is None and TELETHON_AVAILABLE:
        try:
            peer_id = int(utils.get_peer_id(entity))
        except Exception:
            peer_id = entity_id
    access_hash = getattr(entity, "access_hash", None)
    return {
        "telegramGroupId": str(peer_id if peer_id is not None else entity_id),
        "accessHash": str(access_hash) if access_hash is not None else None,
        "title": str(getattr(entity, "title", None) or "Untitled Telegram group")[:300],
        "username": getattr(entity, "username", None),
        "members": getattr(entity, "participants_count", None),
        "type": group_type,
        "language": None,
    }


class TelethonAdapter:
    available = TELETHON_AVAILABLE

    def __init__(self):
        self.client: Any = None
        self.phone: str | None = None
        self.phone_code_hash: str | None = None
        self.message_handler: Any = None
        self.disconnect_callback: Callable[[], Awaitable[Any]] | None = None
        self.disconnect_watch: asyncio.Task | None = None

    def set_disconnect_callback(self, callback: Callable[[], Awaitable[Any]]) -> None:
        self.disconnect_callback = callback

    @staticmethod
    def _flood_wait(error: BaseException) -> BaseException:
        if TELETHON_AVAILABLE and isinstance(error, FloodWaitError):
            from parser_worker.service import FloodWait

            return FloodWait(int(getattr(error, "seconds", 1)))
        return error

    async def _disconnect_client(self) -> None:
        if self.client is not None:
            try:
                await self.client.disconnect()
            finally:
                self.client = None
                self.message_handler = None

    @staticmethod
    def _account(user: Any) -> dict[str, Any]:
        first = str(getattr(user, "first_name", None) or "").strip()
        last = str(getattr(user, "last_name", None) or "").strip()
        return {
            "state": "CONNECTED",
            "userId": str(getattr(user, "id", "") or ""),
            "username": getattr(user, "username", None),
            "displayName": " ".join(part for part in (first, last) if part) or None,
        }

    async def restore(self, *, api_id: int, api_hash: str, phone: str, session: str) -> dict[str, Any] | None:
        if not self.available:
            return None
        await self._disconnect_client()
        client = TelegramClient(StringSession(session), int(api_id), api_hash)
        try:
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                return None
            user = await client.get_me()
        except Exception:
            await client.disconnect()
            return None
        self.client = client
        self.phone = phone
        return self._account(user)

    async def send_code(self, *, api_id: int, api_hash: str, phone: str) -> dict[str, Any]:
        if not self.available:
            raise RuntimeError("Telethon is not installed")
        await self._disconnect_client()
        self.client = TelegramClient(StringSession(), int(api_id), api_hash)
        self.phone = phone
        try:
            await self.client.connect()
            result = await self.client.send_code_request(phone)
        except Exception as error:
            await self._disconnect_client()
            raise self._flood_wait(error)
        self.phone_code_hash = getattr(result, "phone_code_hash", None)
        return {"state": "WAITING_FOR_CODE"}

    async def verify_code(self, *, code: str, password: str | None = None) -> dict[str, Any]:
        if self.client is None or not self.phone:
            raise RuntimeError("Telegram login was not started")
        try:
            if password:
                await self.client.sign_in(password=password)
            else:
                await self.client.sign_in(phone=self.phone, code=code, phone_code_hash=self.phone_code_hash)
        except SessionPasswordNeededError:
            return {"state": "WAITING_FOR_2FA"}
        except Exception as error:
            raise self._flood_wait(error)
        user = await self.client.get_me()
        return {**self._account(user), "session": self.client.session.save()}

    async def disconnect(self, *, revoke: bool) -> None:
        client = self.client
        if client is None:
            return
        try:
            if revoke and await client.is_user_authorized():
                await client.log_out()
            else:
                await client.disconnect()
        finally:
            self.client = None
            self.message_handler = None
            self.phone_code_hash = None

    def _require_client(self) -> Any:
        if self.client is None or not self.client.is_connected():
            raise RuntimeError("Telegram is disconnected")
        return self.client

    async def search_groups(self, query: str, limit: int) -> list[dict[str, Any]]:
        client = self._require_client()
        try:
            result = await client(functions.contacts.SearchRequest(q=query, limit=min(100, max(1, int(limit)))))
        except Exception as error:
            raise self._flood_wait(error)
        groups = []
        seen: set[str] = set()
        for entity in [*getattr(result, "chats", [])]:
            if getattr(entity, "deactivated", False) or getattr(entity, "left", False) and not getattr(entity, "username", None):
                continue
            normalized = normalize_group(entity)
            if normalized["telegramGroupId"] not in seen:
                seen.add(normalized["telegramGroupId"])
                groups.append(normalized)
        return groups[:limit]

    @staticmethod
    def _entity_reference(group: dict[str, Any]) -> Any:
        username = str(group.get("username") or "").strip().lstrip("@")
        if username:
            return username
        group_type = group.get("type")
        access_hash = group.get("accessHash")
        if group_type in {"channel", "supergroup"} and access_hash is not None:
            marked = int(group.get("telegramGroupId") or 0)
            channel_id = abs(marked)
            if str(channel_id).startswith("100") and len(str(channel_id)) > 3:
                channel_id = int(str(channel_id)[3:])
            return InputChannel(channel_id=channel_id, access_hash=int(access_hash))
        raise TelegramOperationError("UNAVAILABLE")

    async def join_group(self, group: dict[str, Any]) -> dict[str, Any]:
        client = self._require_client()
        try:
            await client(functions.channels.JoinChannelRequest(self._entity_reference(group)))
        except Exception as error:
            if TELETHON_AVAILABLE and isinstance(error, FloodWaitError):
                raise self._flood_wait(error)
            code = telegram_error_code(error)
            if code == "ALREADY_JOINED":
                return {"status": code}
            raise TelegramOperationError(code) from error
        return {"status": "JOINED"}

    @staticmethod
    def _input_peer_key(peer: Any) -> tuple[str, int]:
        for kind, attribute in (
            ("channel", "channel_id"),
            ("chat", "chat_id"),
            ("user", "user_id"),
        ):
            value = getattr(peer, attribute, None)
            if value is not None:
                return kind, int(value)
        raise TelegramOperationError("UNAVAILABLE")

    @staticmethod
    def _organization_error(error: BaseException) -> BaseException:
        converted = TelethonAdapter._flood_wait(error)
        if converted is not error:
            return converted
        if isinstance(error, TelegramOperationError):
            return error
        return TelegramOperationError(telegram_error_code(error))

    async def resolve_input_peer(self, group: dict[str, Any]) -> Any:
        client = self._require_client()
        try:
            return await client.get_input_entity(self._entity_reference(group))
        except Exception as error:
            raise self._organization_error(error) from error

    async def get_dialog_filters(self) -> list[Any]:
        client = self._require_client()
        try:
            result = await client(functions.messages.GetDialogFiltersRequest())
            return list(getattr(result, "filters", result))
        except Exception as error:
            raise self._organization_error(error) from error

    async def update_dialog_filter(self, filter_id: int, dialog_filter: Any) -> None:
        client = self._require_client()
        try:
            await client(functions.messages.UpdateDialogFilterRequest(id=int(filter_id), filter=dialog_filter))
        except Exception as error:
            raise self._organization_error(error) from error

    async def create_dialog_filter(self, title: str, include_peers: list[Any]) -> Any:
        current = await self.get_dialog_filters()
        used_ids = {int(item.id) for item in current if getattr(item, "id", None) is not None}
        filter_id = next((candidate for candidate in range(2, 256) if candidate not in used_ids), None)
        if filter_id is None:
            raise TelegramOperationError("FOLDER_LIMIT_REACHED")
        dialog_filter = tl_types.DialogFilter(
            id=filter_id,
            title=tl_types.TextWithEntities(text=str(title), entities=[]),
            pinned_peers=[],
            include_peers=list(include_peers),
            exclude_peers=[],
            contacts=False,
            non_contacts=False,
            groups=False,
            broadcasts=False,
            bots=False,
            exclude_muted=False,
            exclude_read=False,
            exclude_archived=False,
        )
        await self.update_dialog_filter(filter_id, dialog_filter)
        return dialog_filter

    async def get_peer_folder_ids(self, peers: list[Any]) -> dict[tuple[str, int], int | None]:
        if not peers:
            return {}
        client = self._require_client()
        try:
            result = await client(functions.messages.GetPeerDialogsRequest(
                peers=[tl_types.InputDialogPeer(peer=item) for item in peers]
            ))
        except Exception as error:
            raise self._organization_error(error) from error
        folder_ids = {self._input_peer_key(peer): None for peer in peers}
        for dialog in getattr(result, "dialogs", []):
            try:
                folder_ids[self._input_peer_key(dialog.peer)] = getattr(dialog, "folder_id", None)
            except TelegramOperationError:
                continue
        return folder_ids

    async def archive_peers(self, peers: list[Any]) -> None:
        if not peers:
            return
        client = self._require_client()
        try:
            await client(functions.folders.EditPeerFoldersRequest(
                folder_peers=[tl_types.InputFolderPeer(peer=item, folder_id=1) for item in peers]
            ))
        except Exception as error:
            raise self._organization_error(error) from error

    async def leave_group(self, group: dict[str, Any]) -> None:
        client = self._require_client()
        try:
            await client(functions.channels.LeaveChannelRequest(self._entity_reference(group)))
        except Exception as error:
            if TELETHON_AVAILABLE and isinstance(error, FloodWaitError):
                raise self._flood_wait(error)
            raise TelegramOperationError(telegram_error_code(error)) from error

    @staticmethod
    def _message_datetime(message: Any) -> datetime:
        timestamp = getattr(message, "date", None) or datetime.now(UTC)
        return timestamp.replace(tzinfo=UTC) if timestamp.tzinfo is None else timestamp.astimezone(UTC)

    @staticmethod
    def _textual_content(message: Any) -> tuple[str, str]:
        """Return supported Telegram text without attempting OCR on media."""
        for attribute, content_type in (
            ("raw_text", "text"),
            ("message", "text"),
            ("text", "text"),
            ("caption", "caption"),
        ):
            value = str(getattr(message, attribute, "") or "").strip()
            if value:
                return value, content_type
        return "", "media_without_text" if getattr(message, "media", None) is not None else "text"

    async def _message_payload(self, message: Any) -> dict[str, Any]:
        # Telegram can return a valid message while its optional sender/chat entity
        # is no longer resolvable. Preserve the message for the classifier instead
        # of abandoning the remainder of a history scan.
        try:
            chat = await message.get_chat()
        except Exception:
            chat = None
        try:
            sender = await message.get_sender()
        except Exception:
            sender = None
        timestamp = self._message_datetime(message)
        textual_content, content_type = self._textual_content(message)
        reply_payload = None
        if getattr(message, "reply_to", None) is not None and hasattr(message, "get_reply_message"):
            try:
                replied = await message.get_reply_message()
                if replied is not None:
                    reply_text, reply_content_type = self._textual_content(replied)
                    if reply_text:
                        reply_sender = await replied.get_sender() if hasattr(replied, "get_sender") else None
                        reply_payload = {
                            "chatId": str(getattr(replied, "chat_id", "") or "") or None,
                            "messageId": int(getattr(replied, "id", 0) or 0) or None,
                            "authorId": str(getattr(reply_sender, "id", "") or "") or None,
                            "text": reply_text, "contentType": reply_content_type,
                        }
            except Exception:
                # A deleted/inaccessible reply is optional contextual evidence,
                # never a reason to abandon the current Telegram delivery.
                reply_payload = None
        return {
            "telegramGroupId": str(getattr(message, "chat_id", "") or ""),
            "messageId": int(getattr(message, "id", 0) or 0),
            "authorId": str(getattr(sender, "id", "") or "") or None,
            "authorUsername": getattr(sender, "username", None),
            "authorName": " ".join(
                part for part in (
                    str(getattr(sender, "first_name", None) or "").strip(),
                    str(getattr(sender, "last_name", None) or "").strip(),
                ) if part
            ) or None,
            "messageText": textual_content,
            "contentType": content_type,
            "editTimestamp": (
                (lambda edited: (edited.replace(tzinfo=UTC) if edited.tzinfo is None else edited.astimezone(UTC))
                 .isoformat().replace("+00:00", "Z"))(getattr(message, "edit_date"))
                if getattr(message, "edit_date", None) is not None else None
            ),
            "replyTo": reply_payload,
            "messageTimestamp": timestamp.isoformat().replace("+00:00", "Z"),
            "groupTitle": getattr(chat, "title", None),
            "groupUsername": getattr(chat, "username", None),
        }

    async def iter_group_messages(self, group: dict[str, Any], *, after: str, before: str):
        client = self._require_client()
        try:
            after_at = datetime.fromisoformat(str(after).replace("Z", "+00:00"))
            before_at = datetime.fromisoformat(str(before).replace("Z", "+00:00"))
            after_at = after_at.replace(tzinfo=UTC) if after_at.tzinfo is None else after_at.astimezone(UTC)
            before_at = before_at.replace(tzinfo=UTC) if before_at.tzinfo is None else before_at.astimezone(UTC)
            async for message in client.iter_messages(self._entity_reference(group), offset_date=before_at):
                timestamp = self._message_datetime(message)
                if timestamp <= after_at:
                    break
                if timestamp > before_at or getattr(message, "out", False):
                    continue
                payload = await self._message_payload(message)
                # Telethon service events carry neither a textual body nor media;
                # they are outside qualification scope.  Media-only posts remain
                # visible to the audit route as NO_TEXTUAL_CONTENT.
                if not payload["messageText"] and payload["contentType"] != "media_without_text":
                    continue
                yield payload
        except Exception as error:
            raise self._flood_wait(error) from error

    async def start_monitoring(self, callback: Callable[[dict[str, Any]], Awaitable[Any]]) -> None:
        client = self._require_client()
        if self.message_handler is not None:
            return

        async def deliver(event: Any, event_type: str) -> None:
            if getattr(event, "out", False):
                return
            payload = await self._message_payload(event)
            payload["eventType"] = event_type
            result = callback(payload)
            if inspect.isawaitable(result):
                await result

        async def on_new_message(event: Any) -> None:
            await deliver(event, "CREATE")

        async def on_edited_message(event: Any) -> None:
            await deliver(event, "EDIT")

        self.message_handler = (on_new_message, on_edited_message)
        client.add_event_handler(on_new_message, events.NewMessage(incoming=True))
        client.add_event_handler(on_edited_message, events.MessageEdited(incoming=True))
        async def watch_disconnect() -> None:
            try:
                await client.disconnected
                if self.client is client and self.message_handler is not None and self.disconnect_callback is not None:
                    await self.disconnect_callback()
            except asyncio.CancelledError:
                return
        self.disconnect_watch = asyncio.create_task(watch_disconnect())

    async def stop_monitoring(self) -> None:
        if self.disconnect_watch is not None:
            self.disconnect_watch.cancel()
            await asyncio.gather(self.disconnect_watch, return_exceptions=True)
            self.disconnect_watch = None
        if self.client is not None and self.message_handler is not None:
            for handler in self.message_handler if isinstance(self.message_handler, tuple) else (self.message_handler,):
                self.client.remove_event_handler(handler)
        self.message_handler = None

import Currencies from 'tf2-currencies';
import { genUserPure, genScrapAdjustment } from './userSettings';
import Bot from '../Bot';
import { EntryData, KeyPrices, PricelistChangedSource } from '../Pricelist';
import log from '../../lib/logger';
import { currPure } from '../../lib/tools/pure';
import sendAlert from '../../lib/DiscordWebhook/sendAlert';

interface OverallStatus {
    isBuyingKeys: boolean;
    isBankingKeys: boolean;
    checkAlertOnLowPure: boolean;
    alreadyUpdatedToBank: boolean;
    alreadyUpdatedToBuy: boolean;
    alreadyUpdatedToSell: boolean;
}

type SetOverallStatus = [boolean, boolean, boolean, boolean, boolean, boolean];

interface OldAmount {
    keysCanBuy: number;
    keysCanSell: number;
    keysCanBankMin: number;
    keysCanBankMax: number;
    ofKeys: number;
}

type SetOldAmount = [number, number, number, number, number];

export default class Autokeys {
    private readonly bot: Bot;

    get isEnabled(): boolean {
        return this.bot.options.autokeys.enable;
    }

    get isKeyBankingEnabled(): boolean {
        return this.bot.options.autokeys.banking.enable;
    }

    get isEnableScrapAdjustment(): boolean {
        return genScrapAdjustment(
            this.bot.options.autokeys.scrapAdjustment.value,
            this.bot.options.autokeys.scrapAdjustment.enable
        ).enabled;
    }

    get scrapAdjustmentValue(): number {
        return genScrapAdjustment(
            this.bot.options.autokeys.scrapAdjustment.value,
            this.bot.options.autokeys.scrapAdjustment.enable
        ).value;
    }

    get userPure(): {
        minKeys: number;
        maxKeys: number;
        minRefs: number;
        maxRefs: number;
    } {
        return genUserPure(
            this.bot.options.autokeys.minKeys,
            this.bot.options.autokeys.maxKeys,
            this.bot.options.autokeys.minRefined,
            this.bot.options.autokeys.maxRefined
        );
    }

    private isActive = false;

    private set setActiveStatus(set: boolean) {
        this.isActive = set;
    }

    get getActiveStatus(): boolean {
        return this.isActive;
    }

    private status: OverallStatus = {
        isBuyingKeys: false,
        isBankingKeys: false,
        checkAlertOnLowPure: false,
        alreadyUpdatedToBank: false,
        alreadyUpdatedToBuy: false,
        alreadyUpdatedToSell: false
    };

    private set setOverallStatus(set: SetOverallStatus) {
        this.status = {
            isBuyingKeys: set[0],
            isBankingKeys: set[1],
            checkAlertOnLowPure: set[2],
            alreadyUpdatedToBank: set[3],
            alreadyUpdatedToBuy: set[4],
            alreadyUpdatedToSell: set[5]
        };
    }

    get getOverallStatus(): OverallStatus {
        return this.status;
    }

    private oldAmount: OldAmount = {
        keysCanBuy: 0,
        keysCanSell: 0,
        keysCanBankMin: 0,
        keysCanBankMax: 0,
        ofKeys: 0
    };

    private set setOldAmount(set: SetOldAmount) {
        this.oldAmount = {
            keysCanBuy: set[0],
            keysCanSell: set[1],
            keysCanBankMin: set[2],
            keysCanBankMax: set[3],
            ofKeys: set[4]
        };
    }

    private OldKeyPrices: { buy: Currencies; sell: Currencies };

    constructor(bot: Bot) {
        this.bot = bot;
    }

    check(): void {
        log.debug(`checking autokeys (Enabled: ${String(this.isEnabled)})`);
        if (this.isEnabled === false) return;

        const userPure = this.userPure;

        const userMinKeys = userPure.minKeys;
        const userMaxKeys = userPure.maxKeys;
        const userMinRef = userPure.minRefs;
        const userMaxRef = userPure.maxRefs;

        if (isNaN(userMinKeys) || isNaN(userMaxKeys) || isNaN(userMinRef) || isNaN(userMaxRef)) {
            log.warn(
                "You've entered a non-number on either your MINIMUM_KEYS/MINIMUM_REFINED/MAXIMUM_REFINED variables, please correct it. Autokeys is disabled until you correct it."
            );
            return;
        }

        const pure = currPure(this.bot);
        const currKeys = pure.key;
        const currRef = pure.refTotalInScrap;

        const currKeyPrice = this.bot.pricelist.getKeyPrices;
        if (currKeyPrice !== this.OldKeyPrices && this.isEnableScrapAdjustment) {
            // When scrap adjustment activated, if key rate changes, then it will force update key prices after a trade.
            this.setOverallStatus = [false, false, false, false, false, false];
            this.OldKeyPrices = { buy: currKeyPrice.buy, sell: currKeyPrice.sell };
        }

        /**
         * enable Autokeys - Buying - true if currRef \> maxRef AND currKeys \< maxKeys
         */
        const isBuyingKeys = currRef > userMaxRef && currKeys < userMaxKeys;
        /*
        //      <————————————○      \
        // Keys ----|--------|---->  ⟩ AND
        //                   ○————> /
        // Refs ----|--------|---->
        //         min     max
        */

        /**
         * enable Autokeys - Selling - true if currRef \< minRef AND currKeys \> minKeys
         */
        const isSellingKeys = currRef < userMinRef && currKeys > userMinKeys;
        /*
        //          ○—————————————> \
        // Keys ----|--------|---->  ⟩ AND
        //      <———○               /
        // Refs ----|--------|---->
        //         min      max
        */

        /**
         * disable Autokeys - true if currRef \>= maxRef AND currKeys \>= maxKeys OR
         * (minRef \<= currRef \<= maxRef AND currKeys \<= maxKeys)
         */
        const isRemoveAutoKeys =
            (currRef >= userMaxRef && currKeys >= userMaxKeys) ||
            (currRef >= userMinRef && currRef <= userMaxRef && currKeys <= userMaxKeys);
        /*
        //      <————————————●····> \
        // Keys ----|--------|---->  ⟩ AND
        //          ●————————●····> /
        // Refs ----|--------|---->
        //         min      max
        //                 ^^|^^
        //                   OR
        */

        /**
         * enable Autokeys - Banking - true if user set ENABLE_AUTO_KEY_BANKING to true
         */
        const isEnableKeyBanking = this.isKeyBankingEnabled;

        /**
         * enable Autokeys - Banking - true if minRef \< currRef \< maxRef AND currKeys \> minKeys
         */
        const isBankingKeys = currRef > userMinRef && currRef < userMaxRef && currKeys > userMinKeys;
        /*
        //          ○—————————————> \
        // Keys ----|--------|---->  ⟩ AND
        //          ○————————○      /
        // Refs ----|-------|---->
        //         min     max
        */

        /**
         * enable Autokeys - Banking - true if currRef \> minRef AND keys \< minKeys
         * Will buy keys.
         */
        const isBankingBuyKeysWithEnoughRefs = currRef > userMinRef && currKeys <= userMinKeys;
        /*
        //      <———●               \
        // Keys ----|--------|---->  ⟩ AND
        //          ○—————————————> /
        // Refs ----|--------|---->
        //         min      max
        */

        /**
         * disable Autokeys - Banking - true if currRef \< minRef AND currKeys \< minKeys
         */
        const isRemoveBankingKeys = currRef <= userMaxRef && currKeys <= userMinKeys;
        /*
        //      <———●               \
        // Keys ----|--------|---->  ⟩ AND
        //      <————————————●      /
        // Refs ----|--------|---->
        //         min      max
        */

        const isAlreadyAlert = this.status.checkAlertOnLowPure;

        /**
         * send alert to admins when both keys and refs below minimum
         */
        const isAlertAdmins = currRef <= userMinRef && currKeys <= userMinKeys;
        /*
        //      <———●               \
        // Keys ----|--------|---->  ⟩ AND
        //      <———●               /
        // Refs ----|--------|---->
        //         min      max
        */

        const isAlreadyUpdatedToBank = this.status.alreadyUpdatedToBank;
        const isAlreadyUpdatedToBuy = this.status.alreadyUpdatedToBuy;
        const isAlreadyUpdatedToSell = this.status.alreadyUpdatedToSell;

        let setMinKeys: number;
        let setMaxKeys: number;
        const rKeysCanBuy = Math.round((currRef - userMaxRef) / currKeyPrice.buy.toValue());
        const rKeysCanSell = Math.round((userMinRef - currRef) / currKeyPrice.sell.toValue());
        const rKeysCanBankMin = Math.round((userMaxRef - currRef) / currKeyPrice.sell.toValue());
        const rKeysCanBankMax = Math.round((currRef - userMinRef) / currKeyPrice.buy.toValue());

        // Check and set new min and max
        if (isBuyingKeys) {
            // If buying - we need to set min = currKeys and max = currKeys + CanBuy
            const min = currKeys;
            setMinKeys = min <= userMinKeys ? userMinKeys : min;

            const max = currKeys + rKeysCanBuy;
            setMaxKeys = max >= userMaxKeys ? userMaxKeys : max < 1 ? 1 : max;

            if (setMinKeys === setMaxKeys) setMaxKeys += 1;
            else if (setMinKeys > setMaxKeys) setMaxKeys = setMinKeys + 1;

            //
        } else if (isBankingBuyKeysWithEnoughRefs && isEnableKeyBanking) {
            // If buying (while banking) - we need to set min = currKeys and max = currKeys + CanBankMax
            const min = currKeys;
            setMinKeys = min <= userMinKeys ? userMinKeys : min;

            const max = currKeys + rKeysCanBankMax;
            setMaxKeys = max >= userMaxKeys ? userMaxKeys : max < 1 ? 1 : max;

            if (setMinKeys === setMaxKeys) setMaxKeys += 1;
            else if (setMinKeys > setMaxKeys) setMaxKeys = setMinKeys + 2;

            //
        } else if (isSellingKeys) {
            // If selling - we need to set min = currKeys - CanSell and max = currKeys
            const min = currKeys - rKeysCanSell;
            setMinKeys = min <= userMinKeys ? userMinKeys : min;

            const max = currKeys;
            setMaxKeys = max >= userMaxKeys ? userMaxKeys : max < 1 ? 1 : max;

            if (setMinKeys === setMaxKeys) setMinKeys -= 1;
            else if (setMinKeys > setMaxKeys) setMaxKeys = setMinKeys + 1;

            //
        } else if (isBankingKeys && isEnableKeyBanking) {
            // If banking - we need to set min = currKeys - CanBankMin and max = currKeys + CanBankMax
            const min = currKeys - rKeysCanBankMin;
            setMinKeys = min <= userMinKeys ? userMinKeys : min;

            const max = currKeys + rKeysCanBankMax;
            setMaxKeys = max >= userMaxKeys ? userMaxKeys : max < 1 ? 1 : max;

            if (setMinKeys === setMaxKeys) setMinKeys -= 1;
            else if (setMaxKeys - setMinKeys === 1) setMaxKeys += 1;
            // When banking, the bot should be able to both buy and sell keys.
            else if (setMinKeys > setMaxKeys) setMaxKeys = setMinKeys + 2;
        }

        const isAlreadyRunningAutokeys = this.isActive;
        const isKeysAlreadyExist = this.bot.pricelist.getPrice('5021;6', false) !== null;

        const opt = this.bot.options;

        if (isAlreadyRunningAutokeys) {
            // if Autokeys already running
            if (
                isBankingKeys &&
                isEnableKeyBanking &&
                (!isAlreadyUpdatedToBank ||
                    rKeysCanBankMin !== this.oldAmount.keysCanBankMin ||
                    rKeysCanBankMax !== this.oldAmount.keysCanBankMax ||
                    currKeys !== this.oldAmount.ofKeys)
            ) {
                // enable keys banking - if banking conditions to enable banking matched and banking is enabled
                this.setOverallStatus = [false, true, false, true, false, false];
                this.setOldAmount = [0, 0, rKeysCanBankMin, rKeysCanBankMax, currKeys];
                this.setActiveStatus = true;
                this.updateToBank(setMinKeys, setMaxKeys);
                //
            } else if (
                isBankingBuyKeysWithEnoughRefs &&
                isEnableKeyBanking &&
                (!isAlreadyUpdatedToBuy ||
                    rKeysCanBankMax !== this.oldAmount.keysCanBuy ||
                    currKeys !== this.oldAmount.ofKeys)
            ) {
                // enable keys banking - if refs > minRefs but Keys < minKeys, will buy keys.
                this.setOverallStatus = [true, false, false, false, true, false];
                this.setOldAmount = [0, rKeysCanBankMax, 0, 0, currKeys];
                this.setActiveStatus = true;
                this.updateToBuy(setMinKeys, setMaxKeys);
                //
            } else if (
                isBuyingKeys &&
                (!isAlreadyUpdatedToBuy ||
                    rKeysCanBuy !== this.oldAmount.keysCanBuy ||
                    currKeys !== this.oldAmount.ofKeys)
            ) {
                // enable Autokeys - Buying - if buying keys conditions matched
                this.setOverallStatus = [true, false, false, false, true, false];
                this.setOldAmount = [0, rKeysCanBuy, 0, 0, currKeys];
                this.setActiveStatus = true;
                this.updateToBuy(setMinKeys, setMaxKeys);
                //
            } else if (
                isSellingKeys &&
                (!isAlreadyUpdatedToSell ||
                    rKeysCanSell !== this.oldAmount.keysCanSell ||
                    currKeys !== this.oldAmount.ofKeys)
            ) {
                // enable Autokeys - Selling - if selling keys conditions matched
                this.setOverallStatus = [false, false, false, false, false, true];
                this.setOldAmount = [rKeysCanSell, 0, 0, 0, currKeys];
                this.setActiveStatus = true;
                this.updateToSell(setMinKeys, setMaxKeys);
                //
            } else if (isRemoveBankingKeys && isEnableKeyBanking) {
                // disable keys banking - if to conditions to disable banking matched and banking is enabled
                this.setOverallStatus = [false, false, false, false, false, false];
                this.setActiveStatus = false;
                this.disable();
                //
            } else if (isRemoveAutoKeys && !isEnableKeyBanking) {
                // disable Autokeys when conditions to disable Autokeys matched
                this.setOverallStatus = [false, false, false, false, false, false];
                this.setActiveStatus = false;
                this.disable();
                //
            } else if (isAlertAdmins && !isAlreadyAlert) {
                // alert admins when low pure
                this.setOverallStatus = [false, false, true, false, false, false];
                this.setActiveStatus = false;

                const msg = 'I am now low on both keys and refs.';
                if (opt.sendAlert.enable && opt.sendAlert.autokeys.lowPure) {
                    if (opt.discordWebhook.sendAlert.enable && opt.discordWebhook.sendAlert.url !== '') {
                        sendAlert('lowPure', this.bot, msg);
                    } else this.bot.messageAdmins(msg, []);
                }
            }
        } else {
            // if Autokeys is not running/disabled
            if (!isKeysAlreadyExist) {
                // if Mann Co. Supply Crate Key entry does not exist in the pricelist.json
                if (isBankingKeys && isEnableKeyBanking) {
                    //create new Key entry and enable keys banking - if banking conditions to enable banking matched and banking is enabled
                    this.setOverallStatus = [false, true, false, true, false, false];
                    this.setOldAmount = [0, 0, rKeysCanBankMin, rKeysCanBankMax, currKeys];
                    this.setActiveStatus = true;
                    this.createToBank(setMinKeys, setMaxKeys);
                    //
                } else if (isBankingBuyKeysWithEnoughRefs && isEnableKeyBanking) {
                    // enable keys banking - if refs > minRefs but Keys < minKeys, will buy keys.
                    this.setOverallStatus = [true, false, false, false, true, false];
                    this.setOldAmount = [0, rKeysCanBankMax, 0, 0, currKeys];
                    this.setActiveStatus = true;
                    this.createToBuy(setMinKeys, setMaxKeys);
                    //
                } else if (isBuyingKeys) {
                    // create new Key entry and enable Autokeys - Buying - if buying keys conditions matched
                    this.setOverallStatus = [true, false, false, false, true, false];
                    this.setOldAmount = [0, rKeysCanBuy, 0, 0, currKeys];
                    this.setActiveStatus = true;
                    this.createToBuy(setMinKeys, setMaxKeys);
                    //
                } else if (isSellingKeys) {
                    // create new Key entry and enable Autokeys - Selling - if selling keys conditions matched
                    this.setOverallStatus = [false, false, false, false, false, true];
                    this.setOldAmount = [rKeysCanSell, 0, 0, 0, currKeys];
                    this.setActiveStatus = true;
                    this.createToSell(setMinKeys, setMaxKeys);
                    //
                } else if (isAlertAdmins && !isAlreadyAlert) {
                    // alert admins when low pure
                    this.setOverallStatus = [false, false, true, false, false, false];
                    this.setActiveStatus = false;

                    const msg = 'I am now low on both keys and refs.';
                    if (opt.sendAlert.enable && opt.sendAlert.autokeys.lowPure) {
                        if (opt.discordWebhook.sendAlert.enable && opt.discordWebhook.sendAlert.url !== '') {
                            sendAlert('lowPure', this.bot, msg);
                        } else this.bot.messageAdmins(msg, []);
                    }
                }
            } else {
                // if Mann Co. Supply Crate Key entry already in the pricelist.json
                if (
                    isBankingKeys &&
                    isEnableKeyBanking &&
                    (!isAlreadyUpdatedToBank ||
                        rKeysCanBankMin !== this.oldAmount.keysCanBankMin ||
                        rKeysCanBankMax !== this.oldAmount.keysCanBankMax ||
                        currKeys !== this.oldAmount.ofKeys)
                ) {
                    // enable keys banking - if banking conditions to enable banking matched and banking is enabled
                    this.setOverallStatus = [false, true, false, true, false, false];
                    this.setOldAmount = [0, 0, rKeysCanBankMin, rKeysCanBankMax, currKeys];
                    this.setActiveStatus = true;
                    this.updateToBank(setMinKeys, setMaxKeys);
                    //
                } else if (
                    isBankingBuyKeysWithEnoughRefs &&
                    isEnableKeyBanking &&
                    (!isAlreadyUpdatedToBuy ||
                        rKeysCanBankMax !== this.oldAmount.keysCanBuy ||
                        currKeys !== this.oldAmount.ofKeys)
                ) {
                    // enable keys banking - if refs > minRefs but Keys < minKeys, will buy keys.
                    this.setOverallStatus = [true, false, false, false, true, false];
                    this.setOldAmount = [0, rKeysCanBankMax, 0, 0, currKeys];
                    this.setActiveStatus = true;
                    this.updateToBuy(setMinKeys, setMaxKeys);
                    //
                } else if (
                    isBuyingKeys &&
                    (!isAlreadyUpdatedToBuy ||
                        rKeysCanBuy !== this.oldAmount.keysCanBuy ||
                        currKeys !== this.oldAmount.ofKeys)
                ) {
                    // enable Autokeys - Buying - if buying keys conditions matched
                    this.setOverallStatus = [true, false, false, false, true, false];
                    this.setOldAmount = [0, rKeysCanBuy, 0, 0, currKeys];
                    this.setActiveStatus = true;
                    this.updateToBuy(setMinKeys, setMaxKeys);
                    //
                } else if (
                    isSellingKeys &&
                    (!isAlreadyUpdatedToSell ||
                        rKeysCanSell !== this.oldAmount.keysCanSell ||
                        currKeys !== this.oldAmount.ofKeys)
                ) {
                    // enable Autokeys - Selling - if selling keys conditions matched
                    this.setOverallStatus = [false, false, false, false, false, true];
                    this.setOldAmount = [rKeysCanSell, 0, 0, 0, currKeys];
                    this.setActiveStatus = true;
                    this.updateToSell(setMinKeys, setMaxKeys);
                    //
                } else if (isAlertAdmins && !isAlreadyAlert) {
                    // alert admins when low pure
                    this.setOverallStatus = [false, false, true, false, false, false];
                    this.setActiveStatus = false;

                    const msg = 'I am now low on both keys and refs.';
                    if (opt.sendAlert.enable && opt.sendAlert.autokeys.lowPure) {
                        if (opt.discordWebhook.sendAlert.enable && opt.discordWebhook.sendAlert.url !== '') {
                            sendAlert('lowPure', this.bot, msg);
                        } else this.bot.messageAdmins(msg, []);
                    }
                }
            }
        }
        log.debug(
            `Autokeys status:-\n   Ref: minRef(${Currencies.toRefined(userMinRef)})` +
                ` < currRef(${Currencies.toRefined(currRef)})` +
                ` < maxRef(${Currencies.toRefined(userMaxRef)})` +
                `\n   Key: minKeys(${userMinKeys}) ≤ currKeys(${currKeys}) ≤ maxKeys(${userMaxKeys})` +
                `\nStatus: ${
                    isBankingKeys && isEnableKeyBanking && this.isActive
                        ? `Banking (Min: ${setMinKeys}, Max: ${setMaxKeys})`
                        : isBuyingKeys && this.isActive
                        ? `Buying (Min: ${setMinKeys}, Max: ${setMaxKeys})`
                        : isSellingKeys && this.isActive
                        ? `Selling (Min: ${setMinKeys}, Max: ${setMaxKeys})`
                        : 'Not active'
                }`
        );

        this.bot.listings.checkBySKU('5021;6');
    }

    private generateEntry(enabled: boolean, min: number, max: number, intent: 0 | 1 | 2): EntryData {
        const details = this.bot.options.details;
        return {
            sku: '5021;6',
            enabled: enabled,
            autoprice: true,
            min: min,
            max: max,
            intent: intent,
            note: {
                buy: '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬] ' + details.buy,
                sell: '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬] ' + details.sell
            }
        };
    }

    private setManual(entry: EntryData): EntryData {
        const keyPrices = this.bot.pricelist.getKeyPrices;
        entry.autoprice = false;
        entry.buy = {
            keys: 0,
            metal: keyPrices.buy.metal
        };
        entry.sell = {
            keys: 0,
            metal: keyPrices.sell.metal
        };
        return entry;
    }

    private setWithScrapAdjustment(entry: EntryData, keyPrices: KeyPrices, type: 'buy' | 'sell'): EntryData {
        const optSA = this.bot.options.autokeys.scrapAdjustment;
        const scrapAdjustment = genScrapAdjustment(optSA.value, optSA.enable);

        entry.autoprice = false;
        entry.buy = {
            keys: 0,
            metal: Currencies.toRefined(
                keyPrices.buy.toValue() + (type === 'buy' ? scrapAdjustment.value : -scrapAdjustment.value)
            )
        };
        entry.sell = {
            keys: 0,
            metal: Currencies.toRefined(
                keyPrices.sell.toValue() + (type === 'buy' ? scrapAdjustment.value : -scrapAdjustment.value)
            )
        };
        return entry;
    }

    private onError(
        setActive: boolean,
        msg: string,
        isEnableSend: boolean,
        sendToDiscord: boolean,
        type: string
    ): void {
        this.setActiveStatus = setActive;
        log.warn(msg);

        if (isEnableSend) {
            if (sendToDiscord) {
                sendAlert(type, this.bot, msg);
            } else this.bot.messageAdmins(msg, []);
        }
    }

    private createToBank(minKeys: number, maxKeys: number): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(true, minKeys, maxKeys, 2);
        if (keyPrices.src === 'manual') entry = this.setManual(entry);

        this.bot.pricelist
            .addPrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug(`✅ Automatically added Mann Co. Supply Crate Key to bank.`))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    false,
                    `❌ Failed to add Mann Co. Supply Crate Key to bank automatically: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToAdd,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToAdd-bank'
                );
            });
    }

    private createToBuy(minKeys: number, maxKeys: number): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(true, minKeys, maxKeys, 0);
        if (keyPrices.src === 'manual' && !this.isEnableScrapAdjustment) entry = this.setManual(entry);
        else if (this.isEnableScrapAdjustment) entry = this.setWithScrapAdjustment(entry, keyPrices, 'buy');

        this.bot.pricelist
            .addPrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug(`✅ Automatically added Mann Co. Supply Crate Key to buy.`))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    false,
                    `❌ Failed to add Mann Co. Supply Crate Key to buy automatically: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToAdd,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToAdd-buy'
                );
            });
    }

    createToSell(minKeys: number, maxKeys: number): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(true, minKeys, maxKeys, 1);
        if (keyPrices.src === 'manual' && !this.isEnableScrapAdjustment) entry = this.setManual(entry);
        else if (this.isEnableScrapAdjustment) entry = this.setWithScrapAdjustment(entry, keyPrices, 'sell');

        this.bot.pricelist
            .addPrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug(`✅ Automatically added Mann Co. Supply Crate Key to sell.`))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    false,
                    `❌ Failed to add Mann Co. Supply Crate Key to sell automatically: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToAdd,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToAdd-sell'
                );
            });
    }

    private updateToBank(minKeys: number, maxKeys: number): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(true, minKeys, maxKeys, 2);
        if (keyPrices.src === 'manual') entry = this.setManual(entry);

        this.bot.pricelist
            .updatePrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug(`✅ Automatically updated Mann Co. Supply Crate Key to bank.`))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    false,
                    `❌ Failed to update Mann Co. Supply Crate Key to bank automatically: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToUpdate,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToUpdate-bank'
                );
            });
    }

    updateToBuy(minKeys: number, maxKeys: number): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(true, minKeys, maxKeys, 0);
        if (keyPrices.src === 'manual' && !this.isEnableScrapAdjustment) entry = this.setManual(entry);
        else if (this.isEnableScrapAdjustment) entry = this.setWithScrapAdjustment(entry, keyPrices, 'buy');

        this.bot.pricelist
            .updatePrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug(`✅ Automatically update Mann Co. Supply Crate Key to buy.`))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    false,
                    `❌ Failed to update Mann Co. Supply Crate Key to buy automatically: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToUpdate,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToUpdate-buy'
                );
            });
    }

    private updateToSell(minKeys: number, maxKeys: number): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(true, minKeys, maxKeys, 1);
        if (keyPrices.src === 'manual' && !this.isEnableScrapAdjustment) entry = this.setManual(entry);
        else if (this.isEnableScrapAdjustment) entry = this.setWithScrapAdjustment(entry, keyPrices, 'sell');

        this.bot.pricelist
            .updatePrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug(`✅ Automatically updated Mann Co. Supply Crate Key to sell.`))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    false,
                    `❌ Failed to update Mann Co. Supply Crate Key to sell automatically: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToUpdate,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToUpdate-sell'
                );
            });
    }

    disable(): void {
        const keyPrices = this.bot.pricelist.getKeyPrices;

        let entry = this.generateEntry(false, 0, 1, 2);
        if (keyPrices.src === 'manual') entry = this.setManual(entry);

        this.bot.pricelist
            .updatePrice(entry, true, PricelistChangedSource.Autokeys)
            .then(() => log.debug('✅ Automatically disabled Autokeys.'))
            .catch(err => {
                const opt2 = this.bot.options;
                this.onError(
                    true,
                    `❌ Failed to disable Autokeys: ${(err as Error).message}`,
                    opt2.sendAlert.enable && opt2.sendAlert.autokeys.failedToDisable,
                    opt2.discordWebhook.sendAlert.enable && opt2.discordWebhook.sendAlert.url !== '',
                    'autokeys-failedToDisable'
                );
            });
    }

    refresh(): void {
        this.setOverallStatus = [false, false, false, false, false, false];
        this.setActiveStatus = false;
        this.check();
    }
}

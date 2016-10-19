// @flow
// -*- coding: utf-8 -*-
'use strict'
/* !
    region header
    Copyright Torben Sickert (info["~at~"]torben.website) 16.12.2012

    License
    -------

    This library written by Torben Sickert stand under a creative commons naming
    3.0 unported license. see http://creativecommons.org/licenses/by/3.0/deed.de
    endregion
*/
// region imports
import {ChildProcess, spawn as spawnChildProcess} from 'child_process'
import Tools from 'clientnode'
import fileSystem from 'fs'
import fetch from 'node-fetch'
import path from 'path'
import type {
    AllowedModelRolesMapping, Configuration, Model, ModelConfiguration,
    Models, Plugin, PropertySpecification, SimpleModelConfiguration
} from './type'
import WebOptimizerHelper from 'weboptimizer/helper'
import type {PlainObject} from 'weboptimizer/type'
// NOTE: Only needed for debugging this file.
try {
    require('source-map-support/register')
} catch (error) {}
// endregion
// region methods
/**
 * A dumm plugin interface with all available hooks.
 * @property static:closeEventNames - Process event names which indicates that
 * a process has finished.
 */
export default class Helper {
    static closeEventNames:Array<string> = [
        'exit', 'close', 'uncaughtException', 'SIGINT', 'SIGTERM', 'SIGQUIT']
    /**
     * Authenticates given document update against given mapping of allowed
     * roles for writing into corresponding model instances.
     * @param newDocument - Updated document.
     * @param oldDocument - If an existing document should be updated its given
     * here.
     * @param userContext - Contains meta information about currently acting
     * user.
     * @param securitySettings - Database security settings.
     * @param allowedModelRolesMapping - Allowed roles for given models.
     * @param typePropertyName - Property name indicating to which model a
     * document belongs to.
     */
    static authenticate(
        newDocument:Object, oldDocument:?Object, userContext:?Object,
        securitySettings:?Object,
        allowedModelRolesMapping:AllowedModelRolesMapping,
        typePropertyName:string
    ):?true {
        let allowedRoles:Array<string> = ['_admin']
        if (userContext) {
            if (
                allowedModelRolesMapping && typePropertyName &&
                newDocument.hasOwnProperty(typePropertyName) &&
                allowedModelRolesMapping.hasOwnProperty(
                    newDocument[typePropertyName])
            )
                allowedRoles = allowedRoles.concat(
                    allowedModelRolesMapping[newDocument[typePropertyName]])
            for (const userRole:string of userContext.roles)
                if (allowedRoles.includes(userRole))
                    return true
        }
        /* eslint-disable no-throw-literal */
        throw {unauthorized:
            'Only users with a least on of these roles are allowed to ' +
            `perform requested action: "${allowedRoles.join('", "')}".`}
        /* eslint-enable no-throw-literal */
    }
    // region tools
    /**
     * Checks if given url response with given status code.
     * @param url - Url to check reachability.
     * @param wait - Boolean indicating if we should retry until a status code
     * will be given.
     * @param expectedStatusCode - Status code to check for.
     * @param pollIntervallInSeconds - Seconds between two tries to reach given
     * url.
     * @param timeoutInSeconds - Delay after assuming given resource isn't
     * available if no response is coming.
     * @returns A promise which will be resolved if a request to given url has
     * finished and resulting status code matches given expectedstatus code.
     * Otherwise returned promise will be rejected.
     *
     */
    static async checkReachability(
        url:string, wait:boolean = false, expectedStatusCode:number = 200,
        pollIntervallInSeconds:number = 0.1, timeoutInSeconds:number = 10
    ):Promise<?Object> {
        const check:Function = (response:?Object):?Object => {
            if (
                response && 'status' in response &&
                response.status !== expectedStatusCode
            )
                throw new Error(
                    `Given status code ${response.status} differs from ` +
                    `${expectedStatusCode}.`)
            return response
        }
        if (wait)
            return new Promise((resolve:Function, reject:Function):void => {
                let timedOut:boolean = false
                const wrapper:Function = async ():Promise<?Object> => {
                    let response:Object
                    try {
                        response = await fetch(url)
                    } catch (error) {
                        if (!timedOut)
                            /* eslint-disable no-use-before-define */
                            currentlyRunningTimeout = setTimeout(
                                wrapper, pollIntervallInSeconds * 1000)
                            /* eslint-enable no-use-before-define */
                        return response
                    }
                    try {
                        resolve(check(response))
                    } catch (error) {
                        reject(error)
                    } finally {
                        /* eslint-disable no-use-before-define */
                        clearTimeout(timeoutID)
                        /* eslint-enable no-use-before-define */
                    }
                    return response
                }
                let currentlyRunningTimeout = setTimeout(wrapper, 0)
                const timeoutID:number = setTimeout(():void => {
                    timedOut = true
                    clearTimeout(currentlyRunningTimeout)
                    reject('timeout')
                }, timeoutInSeconds * 1000)
            })
        return check(await fetch(url))
    }
    /**
     * Updates/creates a design document in database with a validation function
     * set to given code.
     * @param databaseConnection - Database connection to use for document
     * updates.
     * @param documentName - Design document name.
     * @param validationCode - Code of validation function.
     * @param description - Used to produce semantic logging messages.
     * @param log - Enables logging.
     * @returns Promise which will be resolved after given document has updated
     * successfully.
     */
    static async ensureValidationDocumentPresence(
        databaseConnection:Object, documentName:string, validationCode:string,
        description:string, log:boolean = true
    ):Promise<void> {
        try {
            const document:Object = await databaseConnection.get(
                `_design/${documentName}`)
            await databaseConnection.put({
                _id: `_design/${documentName}`,
                _rev: document._rev,
                language: 'javascript',
                /* eslint-disable camelcase */
                validate_doc_update: validationCode
                /* eslint-enable camelcase */
            })
            if (log)
                console.info(`${description} updated.`)
        } catch (error) {
            if (log)
                if (error.error === 'not_found')
                    console.info(
                        `${description} not available: create new one.`)
                else
                    console.info(
                        `${description} couldn't be updated: "` +
                        `${Helper.representObject(error)}" create new one.`)
            try {
                await databaseConnection.put({
                    _id: `_design/${documentName}`,
                    language: 'javascript',
                    /* eslint-disable camelcase */
                    validate_doc_update: validationCode
                    /* eslint-enable camelcase */
                })
                if (log)
                    console.info(`${description} installed/updated.`)
            } catch (error) {
                throw new Error(
                    `${description} couldn't be installed/updated: "` +
                    `${Helper.representObject(error)}".`)
            }
        }
    }
    /**
     * Represents given object as formatted string.
     * @param object - Object to Represents.
     * @returns Representation string.
     */
    static representObject(object:any):string {
        return JSON.stringify(object, null, 4)
    }
    // endregion
    // region model
    /**
     * Determines a mapping of all models to roles who are allowed to edit
     * corresponding model instances.
     * @param modelConfiguration - Model specification object.
     * @returns The mapping object.
     */
    static determineAllowedModelRolesMapping(
        modelConfiguration:ModelConfiguration
    ):AllowedModelRolesMapping {
        const allowedModelRolesMapping:AllowedModelRolesMapping = {}
        const models:Models = Helper.extendModels(modelConfiguration)
        for (const modelName:string in models)
            if (models.hasOwnProperty(modelName) && models[
                modelName
            ].hasOwnProperty(
                modelConfiguration.specialPropertyNames.allowedRoles
            )) {
                // IgnoreTypeCheck
                const allowedRoles:Array<string> = models[modelName][
                    modelConfiguration.specialPropertyNames.allowedRoles]
                allowedModelRolesMapping[modelName] = allowedRoles
            }
        return allowedModelRolesMapping
    }
    /**
     * Extend given model with all specified one.
     * @param modelName - Name of model to extend.
     * @param models - Pool of models to extend from.
     * @param extendPropertyName - Property name which indicates model
     * inheritance.
     * @returns Given model in extended version.
     */
    static extendModel(
        modelName:string, models:Models,
        extendPropertyName:string = '_extends'
    ):Model {
        if (modelName === '_base')
            return models[modelName]
        if (models.hasOwnProperty('_base'))
            if (models[modelName].hasOwnProperty(extendPropertyName))
                // IgnoreTypeCheck
                models[modelName][extendPropertyName] = ['_base'].concat(
                    models[modelName][extendPropertyName])
            else
                // IgnoreTypeCheck
                models[modelName][extendPropertyName] = '_base'
        if (models[modelName].hasOwnProperty(extendPropertyName)) {
            // IgnoreTypeCheck
            for (const modelNameToExtend:string of [].concat(models[
                modelName
            ][extendPropertyName]))
                models[modelName] = Tools.extendObject(
                    true, models[modelName], Helper.extendModel(
                        modelNameToExtend, models, extendPropertyName))
            delete models[modelName][extendPropertyName]
        }
        return models[modelName]
    }
    /**
     * Extend default specification with specific one.
     * @param modelConfiguration - Model specification object.
     * @returns Models with extended specific specifications.
     */
    static extendModels(modelConfiguration:PlainObject):Models {
        modelConfiguration = Tools.extendObject(true, {specialPropertyNames: {
            defaultPropertySpecification: {},
            specialPropertyNames: {extend: '_extends'},
            typeNameRegularExpressionPattern: '^[A-Z][a-z0-9]+$'
        }}, modelConfiguration)
        const models:Models = {}
        for (const modelName:string in Tools.copyLimitedRecursively(
            modelConfiguration.models
        ))
            if (modelConfiguration.models.hasOwnProperty(
                modelName
            ) && !modelName.startsWith('_')) {
                if (!modelName.match(new RegExp(
                    modelConfiguration.specialPropertyNames
                        .typeNameRegularExpressionPattern
                )))
                    throw new Error(
                        'Model names have to match "' +
                        modelConfiguration.specialPropertyNames
                            .typeNameRegularExpressionPattern +
                        `" (given name: "${modelName}").`)
                models[modelName] = Helper.extendModel(
                    modelName, modelConfiguration.models,
                    modelConfiguration.specialPropertyNames.extend)
            }
        for (const modelName:string in models)
            if (models.hasOwnProperty(modelName))
                for (const propertyName:string in models[modelName])
                    if (models[modelName].hasOwnProperty(propertyName))
                        models[modelName][propertyName] = Tools.extendObject(
                            true, {},
                            modelConfiguration.defaultPropertySpecification,
                            models[modelName][propertyName])
        return models
    }
    /**
     * Represents a design document validation function for given model
     * specification.
     * @param newDocument - Updated document.
     * @param oldDocument - If an existing document should be updated its given
     * here.
     * @param userContext - Contains meta information about currently acting
     * user.
     * @param securitySettings - Database security settings.
     * @param models - Models specfication object.
     * @param modelConfiguration - Model configuration object.
     * @param toJSON - JSON stringifier.
     * @returns Modified given new document.
     */
    static validateDocumentUpdate(
        newDocument:Object, oldDocument:?Object, userContext:Object = {},
        securitySettings:Object = {}, models:Models,
        modelConfiguration:SimpleModelConfiguration, toJSON:?Function = null
    ):Object {
        // region ensure needed environment
        if (newDocument.hasOwnProperty('_deleted') && newDocument._deleted)
            return newDocument
        if (securitySettings.hasOwnProperty(
            modelConfiguration.specialPropertyNames.validatedDocumentsCache
        ) && securitySettings[
            modelConfiguration.specialPropertyNames.validatedDocumentsCache
        ].has(
            `${newDocument._id}-${newDocument._rev}`
        )) {
            securitySettings[
                modelConfiguration.specialPropertyNames.validatedDocumentsCache
            ].delete(`${newDocument._id}-${newDocument._rev}`)
            return newDocument
        }
        if (newDocument.hasOwnProperty(
            '_rev'
        ) && newDocument._rev === 'latest')
            if (oldDocument && oldDocument.hasOwnProperty('_rev'))
                newDocument._rev = oldDocument._rev
            else
                /* eslint-disable no-throw-literal */
                throw {
                    forbidden: 'Revision: No old document to update available.'
                }
                /* eslint-enable no-throw-literal */
        let serialize:(value:any) => string
        if (toJSON)
            serialize = toJSON
        else if (JSON && JSON.hasOwnProperty('stringify'))
            serialize = (object:Object):string => JSON.stringify(
                object, null, 4)
        else
            throw new Error('Needed "serialize" function is not available.')
        // endregion
        const checkDocument:Function = (
            newDocument:Object, oldDocument:?Object
        ):Object => {
            // region check for model type
            if (!newDocument.hasOwnProperty(
                modelConfiguration.specialPropertyNames.type
            ))
                /* eslint-disable no-throw-literal */
                throw {
                    forbidden: 'Type: You have to specify a model type via ' +
                        `property "` +
                        `${modelConfiguration.specialPropertyNames.type}".`
                }
                /* eslint-enable no-throw-literal */
            if (!models.hasOwnProperty(
                newDocument[modelConfiguration.specialPropertyNames.type]
            ))
                /* eslint-disable no-throw-literal */
                throw {
                    forbidden: 'Model: Given model "' + newDocument[
                        modelConfiguration.specialPropertyNames.type
                    ] + ' is not specified.'
                }
                /* eslint-enable no-throw-literal */
            // endregion
            const modelName:string = newDocument[
                modelConfiguration.specialPropertyNames.type]
            const model:Model = models[modelName]
            const checkPropertyContent:Function = (
                newValue:any, name:string,
                propertySpecification:PropertySpecification, oldValue:?any
            ):any => {
                // region type
                if (propertySpecification.type === 'DateTime') {
                    if (typeof newValue !== 'number')
                        /* eslint-disable no-throw-literal */
                        throw {
                            forbidden: `PropertyType: Property "${name}" ` +
                                `isn't of type "DateTime" (given "` +
                                `${serialize(newValue)}").`
                        }
                        /* eslint-enable no-throw-literal */
                } else if (models.hasOwnProperty(propertySpecification.type))
                    if (typeof newValue === 'object' && Object.getPrototypeOf(
                        newValue
                    // IgnoreTypeCheck
                    ) === Object.prototype) {
                        newValue = checkDocument(newValue, oldValue)
                        if (serialize(newValue) === serialize({}))
                            return null
                    } else
                        /* eslint-disable no-throw-literal */
                        throw {
                            forbidden: 'NestedModel: Under key "${name}" ' +
                                `isn't "${propertySpecification.type}" ` +
                                `(given "${serialize(newValue)}").`
                        }
                        /* eslint-enable no-throw-literal */
                else if (['string', 'number', 'boolean'].includes(
                    propertySpecification.type
                )) {
                    if (typeof newValue !== propertySpecification.type)
                        /* eslint-disable no-throw-literal */
                        throw {
                            forbidden: `PropertyType: Property "${name}" ` +
                                `isn't of type "` +
                                `${propertySpecification.type}" (given "` +
                                `${serialize(newValue)}").`
                        }
                        /* eslint-enable no-throw-literal */
                } else if (newValue !== propertySpecification.type)
                    /* eslint-disable no-throw-literal */
                    throw {
                        forbidden: `PropertyType: Property "${name}" isn't ` +
                            `value "${propertySpecification.type}" (given "` +
                            `${serialize(newValue)}").`
                    }
                    /* eslint-disable no-throw-literal */
                // endregion
                // region range
                if (![undefined, null].includes(propertySpecification.minimum))
                    if (propertySpecification.type === 'string') {
                        if (newValue.length < propertySpecification.minimum)
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: `MinimalLength: Property "${name}` +
                                    '" (type string) should have minimal ' +
                                    `length ${propertySpecification.minimum}.`
                            }
                            /* eslint-enable no-throw-literal */
                    } else if ([
                        'number', 'integer', 'float', 'DateTime'
                    ].includes(propertySpecification.type) &&
                    newValue < propertySpecification.minimum)
                        /* eslint-disable no-throw-literal */
                        throw {
                            forbidden: `Minimum: Property "${name}" (type ` +
                                `${propertySpecification.type}) should ` +
                                `satisfy a minimum of ` +
                                `${propertySpecification.minimum}.`
                        }
                        /* eslint-disable no-throw-literal */
                if (![undefined, null].includes(propertySpecification.maximum))
                    if (propertySpecification.type === 'string') {
                        if (newValue.length > propertySpecification.maximum)
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: `MaximalLength: Property "${name}` +
                                    ' (type string) should have maximal ' +
                                    `length ${propertySpecification.maximum}.`
                            }
                            /* eslint-enable no-throw-literal */
                    } else if ([
                        'number', 'integer', 'float', 'DateTime'
                    ].includes(
                        propertySpecification.type
                    ) && newValue > propertySpecification.maximum)
                        /* eslint-enable no-throw-literal */
                        throw {
                            forbidden: `Maximum: Property "${name}" (type ` +
                                `${propertySpecification.type}) should ` +
                                `satisfy a maximum of ` +
                                `${propertySpecification.maximum}.`
                        }
                        /* eslint-disable no-throw-literal */
                // endregion
                // region pattern
                if (!([undefined, null].includes(
                    propertySpecification.regularExpressionPattern
                ) || (new RegExp(
                    // IgnoreTypeCheck
                    propertySpecification.regularExpressionPattern
                )).test(newValue)))
                    /* eslint-enable no-throw-literal */
                    throw {
                        forbidden: `PatternMatch: Property "${name}" should ` +
                            'match regular expression pattern ' +
                            // IgnoreTypeCheck
                            propertySpecification.regularExpressionPattern +
                            ` (given "${newValue}").`
                    }
                    /* eslint-disable no-throw-literal */
                // endregion
                // region generic constraint
                for (const type:string of [
                    'constraintEvaluation', 'constraintExpression'
                ])
                    if (propertySpecification[type]) {
                        let hook:Function
                        try {
                            hook = new Function(
                                'newDocument', 'oldDocument', 'userContext',
                                'securitySettings', 'models',
                                'modelConfiguration', 'serialize', 'modelName',
                                'model', 'checkDocument',
                                'checkPropertyContent', 'newValue', 'name',
                                'propertySpecification', 'oldValue', (
                                    type.endsWith('Evaluation') ? 'return ' :
                                    ''
                                ) + propertySpecification[type])
                        } catch (error) {
                            /* eslint-enable no-throw-literal */
                            throw {
                                forbidden: `Compilation: Hook "${type}" has ` +
                                    `invalid code "` +
                                    `${propertySpecification[type]}": ` +
                                    serialize(error)
                            }
                            /* eslint-disable no-throw-literal */
                        }
                        let satisfied:boolean = false
                        try {
                            // IgnoreTypeCheck
                            satisfied = hook(
                                newDocument, oldDocument, userContext,
                                securitySettings, models, modelConfiguration,
                                serialize, modelName, model, checkDocument,
                                checkPropertyContent, newValue, name,
                                propertySpecification, oldValue)
                        } catch (error) {
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: `Runtime: Hook "${type}" has ` +
                                    'throw an error with code "' +
                                    `${propertySpecification[type]}": ` +
                                    serialize(error)
                            }
                            /* eslint-enable no-throw-literal */
                        }
                        if (!satisfied)
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: type.charAt(0).toUpperCase(
                                ) + type.substring(1) + `: Property "${name}` +
                                `" should satisfy constraint "` +
                                `${propertySpecification[type]}" (given "` +
                                `${serialize(newValue)}").`
                            }
                            /* eslint-enable no-throw-literal */
                    }
                // endregion
                return newValue
            }
            // region run hooks and check for presence of needed data
            for (const propertyName:string in model)
                if (
                    propertyName !== modelConfiguration.specialPropertyNames
                        .allowedRoles &&
                    model.hasOwnProperty(propertyName)
                ) {
                    const propertySpecification:PropertySpecification =
                        model[propertyName]
                    if (!oldDocument)
                        for (const type:string of [
                            'onCreateEvaluation', 'onCreateExpression'
                        ])
                            if (propertySpecification[type]) {
                                let hook:Function
                                try {
                                    hook = newDocument[
                                        propertyName
                                    ] = new Function(
                                        'newDocument', 'oldDocument',
                                        'userContext', 'securitySettings',
                                        'name', 'models', 'modelConfiguration',
                                        'serialize', 'modelName', 'model',
                                        'checkDocument',
                                        'checkPropertyContent',
                                        'propertySpecification', (
                                            type.endsWith('Evaluation') ?
                                            'return ' : ''
                                        ) + propertySpecification[type])
                                } catch (error) {
                                    /* eslint-disable no-throw-literal */
                                    throw {
                                        forbidden: 'Compilation: Hook "' +
                                            `${type}" has invalid code "` +
                                            `${propertySpecification[type]}"` +
                                            `: ${serialize(error)}`
                                    }
                                    /* eslint-enable no-throw-literal */
                                }
                                try {
                                    newDocument[propertyName] = hook(
                                        newDocument, oldDocument, userContext,
                                        securitySettings, propertyName, models,
                                        modelConfiguration, serialize,
                                        modelName, model, checkDocument,
                                        checkPropertyContent,
                                        propertySpecification)
                                } catch (error) {
                                    /* eslint-disable no-throw-literal */
                                    throw {
                                        forbidden: `Runtime: Hook "${type}" ` +
                                            'has throw an error with code "' +
                                            `${propertySpecification[type]}"` +
                                            `: ${serialize(error)}`
                                    }
                                    /* eslint-enable no-throw-literal */
                                }
                            }
                    for (const type:string of [
                        'onUpdateEvaluation', 'onUpdateExpression'
                    ])
                        if (propertySpecification[type]) {
                            let hook:Function
                            try {
                                hook = new Function(
                                    'newDocument', 'oldDocument',
                                    'userContext', 'securitySettings', 'name',
                                    'models', 'modelConfiguration',
                                    'serialize', 'modelName', 'model',
                                    'checkDocument', 'checkPropertyContent',
                                    'propertySpecification', (type.endsWith(
                                        'Evaluation'
                                    ) ? 'return ' : '') +
                                    propertySpecification[type])
                            } catch (error) {
                                /* eslint-disable no-throw-literal */
                                throw {
                                    forbidden: `Compilation: Hook "${type}" ` +
                                        `has invalid code "` +
                                        `${propertySpecification[type]}": ` +
                                        serialize(error)
                                }
                                /* eslint-enable no-throw-literal */
                            }
                            try {
                                newDocument[propertyName] = hook(
                                    newDocument, oldDocument, userContext,
                                    securitySettings, propertyName, models,
                                    modelConfiguration, serialize, modelName,
                                    model, checkDocument, checkPropertyContent,
                                    propertySpecification)
                            } catch (error) {
                                /* eslint-disable no-throw-literal */
                                throw {
                                    forbidden: `Runtime: Hook "${type}" ` +
                                        'has throw an error with code "' +
                                        `${propertySpecification[type]}": ` +
                                        serialize(error)
                                }
                                /* eslint-enable no-throw-literal */
                            }
                        }
                    if ([undefined, null].includes(
                        propertySpecification.default
                    )) {
                        if (!(propertySpecification.nullable || (
                            newDocument.hasOwnProperty(propertyName) ||
                            oldDocument && oldDocument.hasOwnProperty(
                                propertyName)
                        )))
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: 'MissingProperty: Missing ' +
                                    `property "${propertyName}".`
                            }
                            /* eslint-enable no-throw-literal */
                        if (!newDocument.hasOwnProperty(
                            propertyName
                        ) && oldDocument && oldDocument.hasOwnProperty(
                            propertyName
                        ) && modelConfiguration.updateStrategy === 'fillUp')
                            newDocument[propertyName] = oldDocument[
                                propertyName]
                    } else if (!newDocument.hasOwnProperty(
                        propertyName
                    ) || newDocument[propertyName] === null)
                        if (modelConfiguration.updateStrategy === 'fillUp')
                            if (oldDocument)
                                newDocument[propertyName] = oldDocument[
                                    propertyName]
                            else
                                newDocument[propertyName] =
                                    propertySpecification.default
                        else if (
                            modelConfiguration.updateStrategy === 'migrate' ||
                            !oldDocument
                        )
                            newDocument[propertyName] =
                                propertySpecification.default
                }
            // endregion
            // region check given data
            if (
                oldDocument &&
                modelConfiguration.updateStrategy === 'incremental'
            )
                for (const propertyName:string in newDocument)
                    if (
                        newDocument.hasOwnProperty(propertyName) &&
                        propertyName !== modelConfiguration
                            .specialPropertyNames.type &&
                        oldDocument.hasOwnProperty(propertyName) &&
                        oldDocument[propertyName] === newDocument[
                            propertyName
                        ] || serialize(
                            oldDocument[propertyName]
                        ) === serialize(
                            newDocument[propertyName]
                        ) && !modelConfiguration.reservedPropertyNames
                            .includes(propertyName)
                    ) {
                        delete newDocument[propertyName]
                        continue
                    }
            for (const propertyName:string in newDocument)
                if (newDocument.hasOwnProperty(
                    propertyName
                ) && !modelConfiguration.reservedPropertyNames.includes(
                    propertyName
                )) {
                    if (!model.hasOwnProperty(propertyName))
                        if (modelConfiguration.updateStrategy === 'migrate') {
                            delete newDocument[propertyName]
                            continue
                        } else
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: 'Property: Given property "' +
                                    `${propertyName}" isn't specified in ` +
                                    `model "${modelName}".`
                            }
                            /* eslint-enable no-throw-literal */
                    const propertySpecification:PropertySpecification =
                        model[propertyName]
                    // region writable/mutable
                    if (!propertySpecification.writable)
                        if (oldDocument)
                            if (oldDocument.hasOwnProperty(
                                propertyName
                            ) && serialize(
                                newDocument[propertyName]
                            ) === serialize(oldDocument[propertyName])) {
                                if (
                                    propertyName !== '_id' &&
                                    modelConfiguration.updateStrategy ===
                                        'incremental'
                                )
                                    delete newDocument[propertyName]
                                continue
                            } else
                                /* eslint-disable no-throw-literal */
                                throw {
                                    forbidden: 'Readonly: Property "' +
                                        `${propertyName}" is not writable ` +
                                        `(old document "` +
                                        `${serialize(oldDocument)}").`
                                }
                                /* eslint-enable no-throw-literal */
                        else
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: 'Readonly: Property "' +
                                    `${propertyName}" is not writable.`
                            }
                            /* eslint-enable no-throw-literal */
                    if (
                        !propertySpecification.mutable && oldDocument &&
                        oldDocument.hasOwnProperty(propertyName)
                    )
                        if (serialize(newDocument[propertyName]) === serialize(
                            oldDocument[propertyName]
                        )) {
                            if (
                                modelConfiguration.updateStrategy ===
                                    'incremental' &&
                                !modelConfiguration.reservedPropertyNames
                                    .includes(propertyName)
                            )
                                delete newDocument[propertyName]
                            continue
                        } else
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: 'Immutable: Property "' +
                                    `${propertyName}" is not writable (old ` +
                                    `document "${serialize(oldDocument)}").`
                            }
                            /* eslint-enable no-throw-literal */
                    // endregion
                    // region nullable
                    if (newDocument[propertyName] === null)
                        if (propertySpecification.nullable) {
                            delete newDocument[propertyName]
                            continue
                        } else
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: 'NotNull: Property "' +
                                    `${propertyName}" should not by "null".`
                            }
                            /* eslint-enable no-throw-literal */
                    // endregion
                    if (
                        typeof propertySpecification.type === 'string' &&
                        propertySpecification.type.endsWith('[]')
                    ) {
                        if (!Array.isArray(newDocument[propertyName]))
                            /* eslint-disable no-throw-literal */
                            throw {
                                forbidden: 'PropertyType: Property "' +
                                    `${propertyName}" isn't of type "array ` +
                                    `-> ${propertySpecification.type}" (` +
                                    `given "` +
                                    `${serialize(newDocument[propertyName])}` +
                                    '").'
                            }
                            /* eslint-enable no-throw-literal */
                        // IgnoreTypeCheck
                        const propertySpecificationCopy:PropertySpecification =
                            {}
                        for (const key:string in propertySpecification)
                            if (propertySpecification.hasOwnProperty(key))
                                if (key === 'type')
                                    propertySpecificationCopy[key] =
                                        propertySpecification[key].substring(
                                            0,
                                            propertySpecification.type.length -
                                                '[]'.length)
                                else
                                    propertySpecificationCopy[key] =
                                        propertySpecification[key]
                        let index:number = 0
                        for (const value:any of newDocument[
                            propertyName
                        ].slice()) {
                            newDocument[propertyName][index] =
                                checkPropertyContent(
                                    value,
                                    `${index + 1}. value in ${propertyName}`,
                                    propertySpecificationCopy)
                            if (newDocument[propertyName][index] === null)
                                newDocument[propertyName].splice(index, 1)
                            index += 1
                        }
                    } else {
                        newDocument[propertyName] = checkPropertyContent(
                            newDocument[propertyName], propertyName,
                            propertySpecification,
                            oldDocument && oldDocument.hasOwnProperty(
                                propertyName
                            ) && oldDocument[propertyName] || undefined)
                        if (newDocument[propertyName] === null)
                            delete newDocument[propertyName]
                    }
                }
            // endregion
            return newDocument
        }
        newDocument = checkDocument(newDocument, oldDocument)
        if (securitySettings.hasOwnProperty('checkedDocuments'))
            securitySettings[
                modelConfiguration.specialPropertyNames.validatedDocumentsCache
            ].add(`${newDocument._id}-${newDocument._rev}`)
        else
            securitySettings[
                modelConfiguration.specialPropertyNames.validatedDocumentsCache
            ] = new Set([`${newDocument._id}-${newDocument._rev}`])
        return newDocument
    }
    // endregion
    // region plugin
    /**
     * Calls all plugin methods for given trigger description.
     * @param type - Type of trigger.
     * @param plugins - List of plugins to search for trigger callbacks in.
     * @param baseConfiguration - Immutable base configuration.
     * @param configuration - Plugin extendable configuration object.
     * @param data - Data to pipe throw all plugins and resolve after all
     * plugins have been resolved.
     * @param parameter - Additional parameter to forward into plugin api.
     * @returns A promise which resolves when all callbacks have resolved their
     * promise.
     */
    static async callPluginStack(
        type:string, plugins:Array<Object>, baseConfiguration:Configuration,
        configuration:Configuration, data:any = null, ...parameter:Array<any>
    ):Promise<any> {
        if (configuration.plugin.hotReloading) {
            const pluginsWithChangedConfiguration = Helper.hotReloadPluginFile(
                'configurationFile', 'configuration', plugins)
            if (pluginsWithChangedConfiguration.length) {
                Helper.loadPluginConfigurations(configuration, plugins)
                Helper.callPluginStack(
                    'configurationReloaded', plugins, baseConfiguration,
                    configuration, configuration,
                    pluginsWithChangedConfiguration)
            }
            const pluginsWithChangedAPIFiles = Helper.hotReloadPluginFile(
                'apiFile', 'scope', plugins)
            if (pluginsWithChangedAPIFiles.length)
                Helper.callPluginStack(
                    'apiFileReloaded', plugins, baseConfiguration,
                    configuration, pluginsWithChangedConfiguration)
        }
        for (const plugin:Object of plugins)
            data = await plugin.api.apply(Helper, [type, data].concat(
                parameter
            ).concat([plugins, baseConfiguration, configuration]))
        return data
    }
    /**
     * Checks for changed plugin file type in given plugins and reloads them
     * if necessary (new timestamp).
     * @param type - Plugin file type to search for updates.
     * @param targetType - Property name to in plugin meta informations to
     * update.
     * @param plugins - List of plugins to search for updates in.
     * @returns A list with plugins which have a changed plugin file of given
     * type.
     */
    static hotReloadPluginFile(
        type:string, targetType:string, plugins:Array<Plugin>
    ):Array<Plugin> {
        const pluginsWithChangedFiles:Array<Plugin> = []
        for (const plugin:Plugin of plugins)
            if (plugin[type]) {
                const timestamp:number = fileSystem.statSync(
                    plugin[`${type}Path`]
                ).mtime.getTime()
                if (plugin[`${type}LoadTimestamp`] < timestamp) {
                    // Enforce to reload new file version.
                    /* eslint-disable no-eval */
                    delete eval('require').cache[eval('require').resolve(
                        plugin[type])]
                    /* eslint-enable no-eval */
                    plugin[targetType] = Helper.loadPluginFile(
                        plugin[type], plugin.name, plugin[targetType])
                    pluginsWithChangedFiles.push(plugin)
                }
                plugin[`${type}LoadTimestamp`] = timestamp
            }
        return pluginsWithChangedFiles
    }
    /**
     * Extends given configuration object with given plugin specific ones and
     * returns a plugin specific meta information object.
     * @param name - Name of plugin to extend.
     * @param plugins - List of all yet determined plugin informations.
     * @param configurationPropertyNames - Property names to search for to use
     * as entry in plugin configuration file.
     * @param pluginPath - Path to given plugin.
     * @returns An object of plugin specific meta informations.
     */
    static loadPlugin(
        name:string, plugins:{[key:string]:Plugin},
        configurationPropertyNames:Array<string>, pluginPath:string
    ):Plugin {
        let configurationFilePath:string = path.resolve(
            pluginPath, 'package.json')
        let pluginConfiguration:?PlainObject = null
        if (configurationFilePath && WebOptimizerHelper.isDirectorySync(
            pluginPath
        ) && WebOptimizerHelper.isFileSync(configurationFilePath))
            pluginConfiguration = Helper.loadPluginFile(
                configurationFilePath, name)
        if (pluginConfiguration) {
            for (const propertyName:string of configurationPropertyNames)
                if (pluginConfiguration.hasOwnProperty(propertyName)) {
                    let apiFilePath:string = 'index.js'
                    if (pluginConfiguration.hasOwnProperty('main'))
                        apiFilePath = pluginConfiguration.main
                    return Helper.loadPluginAPI(
                        apiFilePath, pluginPath, name, plugins,
                        pluginConfiguration, configurationFilePath)
                }
            throw new Error(
                `Plugin "${name}" hasn't working configuration object under ` +
                `one of the following keys: "` +
                `${configurationPropertyNames.join(", ")}".`)
        }
        return Helper.loadPluginAPI('index.js', pluginPath, name, plugins)
    }
    /**
     * Load given plugin api file in given plugin path generates a plugin
     * specific data structure with useful meta informations.
     * @param relativeFilePath - Path to file to load relatively from given
     * plugin path.
     * @param pluginPath - Path to plugin directory.
     * @param name - Plugin name to use for proper error messages.
     * @param plugins - List of plugins to search for trigger callbacks in.
     * @param configuration - Plugin specific configurations.
     * @param configurationFilePath - Plugin specific configuration file path.
     * @returns Plugin meta informations object.
     */
    static loadPluginAPI(
        relativeFilePath:string, pluginPath:string, name:string,
        plugins:{[key:string]:Object}, configuration:?PlainObject = null,
        configurationFilePath:?string = null
    ):Plugin {
        let filePath:string = path.resolve(pluginPath, relativeFilePath)
        if (!WebOptimizerHelper.isFileSync(filePath))
            for (const fileName:string of fileSystem.readdirSync(pluginPath))
                if (
                    fileName !== 'package.json' &&
                    WebOptimizerHelper.isFileSync(path.resolve(
                        pluginPath, fileName
                    ))
                ) {
                    filePath = path.resolve(pluginPath, filePath)
                    if (['index', 'main'].includes(path.basename(
                        filePath, path.extname(fileName)
                    )))
                        break
                }
        let api:?Function = null
        if (WebOptimizerHelper.isFileSync(filePath))
            if (filePath.endsWith('.js'))
                api = async (type:string, ...parameter:Array<any>):any => {
                    if (type in plugins[name].scope)
                        return await plugins[name].scope[type].apply(
                            plugins[name].scope, parameter)
                }
            else
                api = ():Promise<any> => new Promise((
                    resolve:Function, reject:Function
                ):void => {
                    const childProcess:ChildProcess = spawnChildProcess(
                        filePath, Tools.arrayMake(arguments), {
                            cwd: process.cwd(),
                            env: process.env,
                            shell: true,
                            stdio: 'inherit'
                        })
                    for (const closeEventName:string of Helper.closeEventNames)
                        childProcess.on(
                            closeEventName,
                            WebOptimizerHelper.getProcessCloseHandler(
                                resolve, reject, closeEventName))
                })
        return {
            api,
            apiFilePath: api && filePath,
            apiFileLoadTimestamp: api && fileSystem.statSync(
                filePath
            ).mtime.getTime(),
            configuration,
            configurationFilePath,
            configurationFileLoadTimestamp: configurationFilePath &&
                fileSystem.statSync(configurationFilePath).mtime.getTime() ||
                null,
            name,
            path: pluginPath,
            scope: api && Helper.loadPluginFile(filePath, name)
        }
    }
    /**
     * Re-/Loads given plugin configurations into global configuration.
     * @param configuration - Global configuration to extend.
     * @param plugins - Topological sorted list of plugins to check for
     * configurations.
     * @returns Updated given configuration object.
     */
    static loadPluginConfigurations(
        configuration:Configuration, plugins:Array<Plugin>
    ):Configuration {
        for (const plugin:Plugin of plugins)
            if (plugin.configuration)
                configuration = Tools.extendObject(true, Tools.modifyObject(
                    configuration, plugin.configuration
                ), plugin.configuration)
        const parameterDescription:Array<string> = [
            'self', 'webNodePath', 'currentPath', 'path', 'helper', 'tools',
            'plugins']
        const parameter:Array<any> = [
            configuration, __dirname, process.cwd(), path, Helper, Tools,
            plugins]
        return Tools.unwrapProxy(Tools.resolveDynamicDataStructure(
            configuration, parameterDescription, parameter))
    }
    /**
     * Load given api file path and returns exported scope.
     * @param filePath - Path to file to load.
     * @param name - Plugin name to use for proper error messages.
     * @param fallbackScope - Scope to return if an error occurs during
     * loading. If a "null" is given an error will be thrown.
     * @param log - Enables logging.
     * @returns Exported api file scope.
     */
    static loadPluginFile(
        filePath:string, name:string, fallbackScope:?Object = null,
        log:boolean = true
    ):Object {
        let scope:Object
        try {
            /* eslint-disable no-eval */
            scope = eval('require')(filePath)
            /* eslint-enable no-eval */
        } catch (error) {
            if (fallbackScope) {
                scope = fallbackScope
                if (log)
                    console.warn(
                        `Couln't load new api plugin file "${filePath}" for ` +
                        `plugin "${name}": ${Helper.representObject(error)}.` +
                        ` Using fallback one.`)
            } else
                throw new Error(
                    `Couln't load plugin file "${filePath}" for plugin "` +
                    `${name}": ${Helper.representObject(error)}`)
        }
        return scope
    }
    /**
     * Extends given configuration object with all plugin specific ones and
     * returns a topological sorted list of plugins with plugins specific
     * meta informations stored.
     * @param configuration - Configuration object to extend and use.
     * @returns A topological sorted list of plugins objects.
     */
    static loadPlugins(configuration:Configuration):{
        configuration:Configuration;
        plugins:Array<Plugin>
    } {
        const plugins:{[key:string]:Object} = {}
        for (const type:string in configuration.plugin.directories)
            if (configuration.plugin.directories.hasOwnProperty(
                type
            ) && WebOptimizerHelper.isDirectorySync(
                configuration.plugin.directories[type].path
            ))
                fileSystem.readdirSync(
                    configuration.plugin.directories[type].path
                ).forEach((pluginName:string):void => {
                    if (!(new RegExp(configuration.plugin.directories[
                        type
                    ].nameRegularExpressionPattern)).test(pluginName))
                        return
                    const currentPluginPath:string = path.resolve(
                        configuration.plugin.directories[type].path, pluginName
                    )
                    plugins[pluginName] = Helper.loadPlugin(
                        pluginName, plugins,
                        configuration.plugin.configurationPropertyNames,
                        currentPluginPath)
                })
        const sortedPlugins:Array<Plugin> = []
        const temporaryPlugins:{[key:string]:Array<string>} = {}
        for (const pluginName:string in plugins)
            if (plugins.hasOwnProperty(pluginName))
                if (plugins[pluginName].hasOwnProperty('dependencies'))
                    temporaryPlugins[pluginName] = plugins[
                        pluginName
                    ].dependencies
                else
                    temporaryPlugins[pluginName] = []
        for (const pluginName:string of Tools.arraySortTopological(
            temporaryPlugins
        ))
            sortedPlugins.push(plugins[pluginName])
        return {
            plugins: sortedPlugins,
            configuration: Helper.loadPluginConfigurations(
                configuration, sortedPlugins)
        }
    }
    // endregion
}
// endregion
// region vim modline
// vim: set tabstop=4 shiftwidth=4 expandtab:
// vim: foldmethod=marker foldmarker=region,endregion:
// endregion

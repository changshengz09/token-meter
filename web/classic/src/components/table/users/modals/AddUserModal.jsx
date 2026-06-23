/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useState, useRef } from 'react';
import { API, showError, showSuccess } from '../../../../helpers';
import { useIsMobile } from '../../../../hooks/common/useIsMobile';
import {
  Button,
  SideSheet,
  Space,
  Spin,
  Typography,
  Card,
  Tag,
  Avatar,
  Form,
  Row,
  Col,
  Icon,
} from '@douyinfe/semi-ui';
import { IconSave, IconClose, IconUserAdd } from '@douyinfe/semi-icons';
import { useTranslation } from 'react-i18next';

const { Text, Title } = Typography;

// 密码复杂度门槛：长度 8-20，且至少包含 大写/小写/数字/特殊字符 中的 3 类
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const PASSWORD_MIN_CATEGORIES = 3;

const countPasswordCategories = (pwd) => {
  let categories = 0;
  if (/[a-z]/.test(pwd)) categories++;
  if (/[A-Z]/.test(pwd)) categories++;
  if (/[0-9]/.test(pwd)) categories++;
  if (/[^a-zA-Z0-9]/.test(pwd)) categories++;
  return categories;
};

// 返回密码各项约束的满足情况，用于实时校验提示
const getPasswordChecks = (pwd) => {
  const categories = countPasswordCategories(pwd);
  return [
    {
      key: 'length',
      label: `长度 ${PASSWORD_MIN_LENGTH} - ${PASSWORD_MAX_LENGTH} 位`,
      ok:
        pwd.length >= PASSWORD_MIN_LENGTH && pwd.length <= PASSWORD_MAX_LENGTH,
    },
    {
      key: 'category',
      label: `包含大写字母、小写字母、数字、特殊字符中至少 ${PASSWORD_MIN_CATEGORIES} 类（当前 ${categories}/${PASSWORD_MIN_CATEGORIES}）`,
      ok: categories >= PASSWORD_MIN_CATEGORIES,
    },
  ];
};

const AddUserModal = (props) => {
  const { t } = useTranslation();
  const formApiRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();

  // 用户名重复校验
  const [usernameAvailable, setUsernameAvailable] = useState(null);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const usernameCheckTimerRef = useRef(null);

  // 密码实时校验提示
  const [password, setPassword] = useState('');

  const handleUsernameChange = (value) => {
    if (usernameCheckTimerRef.current) {
      clearTimeout(usernameCheckTimerRef.current);
    }
    if (!value || value.length < 3) {
      setUsernameAvailable(null);
      setCheckingUsername(false);
      return;
    }
    setCheckingUsername(true);
    setUsernameAvailable(null);
    usernameCheckTimerRef.current = setTimeout(async () => {
      try {
        const res = await API.get(
          `/api/user/check-username?username=${encodeURIComponent(value)}`,
        );
        if (res.data.success) {
          setUsernameAvailable(res.data.data.available);
        } else {
          setUsernameAvailable(null);
        }
      } catch {
        setUsernameAvailable(null);
      } finally {
        setCheckingUsername(false);
        formApiRef.current?.validate(['username']).catch(() => {});
      }
    }, 500);
  };

  const validateUsername = (value) => {
    if (!value) return t('请输入用户名');
    if (value.length < 3) return t('用户名长度不得小于 3 位');
    if (usernameAvailable === false) return t('用户名已被占用，请更换用户名');
    return '';
  };

  const handlePasswordChange = (value) => {
    setPassword(value);
    // 密码变化时，若已填写确认密码则同步校验一致性
    if (formApiRef.current?.getValue('password2')) {
      formApiRef.current.validate(['password2']).catch(() => {});
    }
  };

  const validatePassword = (value) => {
    if (!value) return t('请输入密码');
    if (
      value.length < PASSWORD_MIN_LENGTH ||
      value.length > PASSWORD_MAX_LENGTH
    )
      return t('密码长度需为 8 - 20 位');
    if (countPasswordCategories(value) < PASSWORD_MIN_CATEGORIES)
      return t('密码需包含大写字母、小写字母、数字、特殊字符中的至少 3 类');
    return '';
  };

  const validatePassword2 = (value, values) => {
    if (!value) return t('请再次输入密码');
    if (value !== values.password) return t('两次输入的密码不一致');
    return '';
  };

  const getInitValues = () => ({
    username: '',
    display_name: '',
    password: '',
    password2: '',
    remark: '',
  });

  const submit = async (values) => {
    setLoading(true);
    // password2 仅用于前端二次确认，不提交给后端
    const { password2, ...payload } = values;
    const res = await API.post(`/api/user/`, payload);
    const { success, message } = res.data;
    if (success) {
      showSuccess(t('用户账户创建成功！'));
      formApiRef.current?.setValues(getInitValues());
      setUsernameAvailable(null);
      setCheckingUsername(false);
      setPassword('');
      props.refresh();
      props.handleClose();
    } else {
      showError(message);
    }
    setLoading(false);
  };

  const handleCancel = () => {
    props.handleClose();
  };

  return (
    <>
      <SideSheet
        placement={'left'}
        title={
          <Space>
            <Tag color='green' shape='circle'>
              {t('新建')}
            </Tag>
            <Title heading={4} className='m-0'>
              {t('添加用户')}
            </Title>
          </Space>
        }
        bodyStyle={{ padding: '0' }}
        visible={props.visible}
        width={isMobile ? '100%' : 600}
        footer={
          <div className='flex justify-end bg-white'>
            <Space>
              <Button
                theme='solid'
                onClick={() => formApiRef.current?.submitForm()}
                icon={<IconSave />}
                loading={loading}
              >
                {t('提交')}
              </Button>
              <Button
                theme='light'
                type='primary'
                onClick={handleCancel}
                icon={<IconClose />}
              >
                {t('取消')}
              </Button>
            </Space>
          </div>
        }
        closeIcon={null}
        onCancel={() => handleCancel()}
      >
        <Spin spinning={loading}>
          <Form
            initValues={getInitValues()}
            getFormApi={(api) => (formApiRef.current = api)}
            onSubmit={submit}
            onSubmitFail={(errs) => {
              const first = Object.values(errs)[0];
              if (first) showError(Array.isArray(first) ? first[0] : first);
              formApiRef.current?.scrollToError();
            }}
          >
            <div className='p-2'>
              <Card className='!rounded-2xl shadow-sm border-0'>
                <div className='flex items-center mb-2'>
                  <Avatar size='small' color='blue' className='mr-2 shadow-md'>
                    <IconUserAdd size={16} />
                  </Avatar>
                  <div>
                    <Text className='text-lg font-medium'>{t('用户信息')}</Text>
                    <div className='text-xs text-gray-600'>
                      {t('创建新用户账户')}
                    </div>
                  </div>
                </div>

                <Row gutter={12}>
                  <Col span={24}>
                    <Form.Input
                      field='username'
                      label={t('用户名')}
                      placeholder={t('请输入用户名')}
                      validate={validateUsername}
                      onChange={handleUsernameChange}
                      trigger={['change', 'blur']}
                      suffix={
                        checkingUsername ? (
                          <Icon type='loading' spin />
                        ) : usernameAvailable === true ? (
                          <Icon
                            type='tick_circle'
                            style={{ color: 'var(--semi-color-success)' }}
                          />
                        ) : usernameAvailable === false ? (
                          <Icon
                            type='close_circle'
                            style={{ color: 'var(--semi-color-danger)' }}
                          />
                        ) : null
                      }
                    />
                    {usernameAvailable === true && (
                      <Text type='success' size='small'>
                        {t('用户名可用')}
                      </Text>
                    )}
                  </Col>
                  <Col span={24}>
                    <Form.Input
                      field='display_name'
                      label={t('显示名称')}
                      placeholder={t('请输入显示名称')}
                      showClear
                    />
                  </Col>
                  <Col span={24}>
                    <Form.Input
                      field='password'
                      label={t('密码')}
                      mode='password'
                      placeholder={t('输入密码，最短 8 位，最长 20 位')}
                      validate={validatePassword}
                      onChange={handlePasswordChange}
                      trigger={['change', 'blur']}
                    />
                    <div className='mt-1'>
                      <Text size='small' type='tertiary'>
                        {t('密码需满足以下条件：')}
                      </Text>
                      <div className='mt-0.5 flex flex-col gap-0.5'>
                        {getPasswordChecks(password).map((check) => {
                          // 未输入时灰色待办，输入后按是否满足显示绿/红
                          const stateColor = !password
                            ? 'var(--semi-color-text-2)'
                            : check.ok
                              ? 'var(--semi-color-success)'
                              : 'var(--semi-color-danger)';
                          return (
                            <div
                              key={check.key}
                              className='flex items-center gap-1'
                              style={{ color: stateColor }}
                            >
                              <Icon
                                type={check.ok ? 'tick_circle' : 'close_circle'}
                                size='small'
                              />
                              <Text size='small' style={{ color: stateColor }}>
                                {t(check.label)}
                              </Text>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </Col>
                  <Col span={24}>
                    <Form.Input
                      field='password2'
                      label={t('确认密码')}
                      mode='password'
                      placeholder={t('请再次输入密码')}
                      validate={validatePassword2}
                      trigger={['change', 'blur']}
                    />
                  </Col>
                  <Col span={24}>
                    <Form.Input
                      field='remark'
                      label={t('备注')}
                      placeholder={t('请输入备注（仅管理员可见）')}
                      showClear
                    />
                  </Col>
                </Row>
              </Card>
            </div>
          </Form>
        </Spin>
      </SideSheet>
    </>
  );
};

export default AddUserModal;
